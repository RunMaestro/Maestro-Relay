import type { Database } from 'better-sqlite3';
import { db } from '../../core/db';

interface TeamsConversationRefRow {
  conversation_id: string;
  reference_json: string;
  service_url: string;
  tenant_id: string | null;
  updated_at: number;
}

export function createConversationRefsDb(database: Database) {
  return {
    upsert(
      conversationId: string,
      ref: unknown,
      serviceUrl: string,
      tenantId: string | null,
    ): void {
      database.prepare(
        `INSERT INTO teams_conversation_refs (conversation_id, reference_json, service_url, tenant_id, updated_at)
         VALUES (?, ?, ?, ?, unixepoch())
         ON CONFLICT(conversation_id) DO UPDATE SET
           reference_json = excluded.reference_json,
           service_url    = excluded.service_url,
           tenant_id      = excluded.tenant_id,
           updated_at     = unixepoch()`,
      ).run(conversationId, JSON.stringify(ref), serviceUrl, tenantId);
    },

    get(conversationId: string): { reference: unknown } | undefined {
      const row = database
        .prepare('SELECT * FROM teams_conversation_refs WHERE conversation_id = ?')
        .get(conversationId) as TeamsConversationRefRow | undefined;
      if (!row) return undefined;
      return { reference: JSON.parse(row.reference_json) };
    },

    remove(conversationId: string): void {
      database
        .prepare('DELETE FROM teams_conversation_refs WHERE conversation_id = ?')
        .run(conversationId);
    },
  };
}

export const conversationRefsDb = createConversationRefsDb(db);
