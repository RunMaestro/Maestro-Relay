/**
 * Teams "deploy" — produce the app package zip an admin sideloads.
 *
 * Unlike Discord (which registers slash commands against an API), Teams deploy
 * is an offline packaging step: read appPackage/manifest.json, substitute the
 * placeholders from the environment, and write appPackage/maestro-relay-teams.zip
 * containing the substituted manifest plus both icons.
 *
 * Placeholders (see appPackage/README.md):
 *   <TEAMS_APP_ID>  ← process.env.TEAMS_APP_ID    (id + bots[0].botId)
 *   <public-host>   ← host of process.env.TEAMS_PUBLIC_URL (validDomains[0])
 *
 * Run via: npm run deploy-teams
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { deflateRawSync } from 'zlib';

const APP_PACKAGE_DIR = join(__dirname, '../../../appPackage');
const MANIFEST_PATH = join(APP_PACKAGE_DIR, 'manifest.json');
const COLOR_ICON = 'color.png';
const OUTLINE_ICON = 'outline.png';
const OUT_ZIP = join(APP_PACKAGE_DIR, 'maestro-relay-teams.zip');

/** CRC32 (used by the zip format) — standard reflected polynomial table. */
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Minimal ZIP writer (deflate method, no external deps). Sufficient for the
 * handful of small files in a Teams app package.
 */
function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data);
    const useDeflate = compressed.length < entry.data.length;
    const stored = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8); // compression method
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(stored.length, 18); // compressed size
    localHeader.writeUInt32LE(entry.data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    localParts.push(localHeader, nameBuf, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += localHeader.length + nameBuf.length + stored.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const localData = Buffer.concat(localParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // total entries
  end.writeUInt32LE(centralDir.length, 12); // central dir size
  end.writeUInt32LE(localData.length, 16); // central dir offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localData, centralDir, end]);
}

/** Derive the bare host (e.g. example.com) from a public URL. */
function hostFrom(publicUrl: string): string {
  try {
    return new URL(publicUrl).host;
  } catch {
    // Allow a bare host to be passed directly.
    return publicUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function deploy(): void {
  const appId = process.env.TEAMS_APP_ID;
  const publicUrl = process.env.TEAMS_PUBLIC_URL;

  const missing: string[] = [];
  if (!appId) missing.push('TEAMS_APP_ID');
  if (!publicUrl) missing.push('TEAMS_PUBLIC_URL');
  if (missing.length > 0) {
    console.error(
      `Cannot build Teams app package: missing required env var(s): ${missing.join(', ')}.\n` +
        'Set TEAMS_APP_ID (Entra app id) and TEAMS_PUBLIC_URL (public HTTPS base URL), then re-run.',
    );
    process.exit(1);
  }

  const host = hostFrom(publicUrl!);
  if (!host) {
    console.error(`Cannot derive a host from TEAMS_PUBLIC_URL="${publicUrl}".`);
    process.exit(1);
  }

  const rawManifest = readFileSync(MANIFEST_PATH, 'utf8');
  const substituted = rawManifest
    .replace(/<TEAMS_APP_ID>/g, appId!)
    .replace(/<public-host>/g, host);

  // Validate the substituted manifest is still valid JSON.
  JSON.parse(substituted);

  const entries: ZipEntry[] = [
    { name: 'manifest.json', data: Buffer.from(substituted, 'utf8') },
    { name: COLOR_ICON, data: readFileSync(join(APP_PACKAGE_DIR, COLOR_ICON)) },
    { name: OUTLINE_ICON, data: readFileSync(join(APP_PACKAGE_DIR, OUTLINE_ICON)) },
  ];

  const zip = buildZip(entries);
  writeFileSync(OUT_ZIP, zip);

  console.log(`Wrote ${OUT_ZIP} (${zip.length} bytes).`);
  console.log(`  app id: ${appId}`);
  console.log(`  valid domain: ${host}`);
  console.log('A Teams admin uploads this zip — see docs/teams.md for the sideload runbook.');
}

deploy();
