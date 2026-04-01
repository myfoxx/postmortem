import { DurableObject } from 'cloudflare:workers';

export interface Env {
  VAULT:         DurableObjectNamespace;
  AUDIO_BUCKET:  R2Bucket;
  ELEVENLABS_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  FRONTEND_URL:  string;
}

// ── TYPES ────────────────────────────────────────────────────────
interface VaultRow {
  vault_id:     string;
  sender:       string;
  recipient:    string;
  voice_id:     string;
  message_text: string;
  audio_r2_key: string;
  unlock_type:  'date' | 'code';
  unlock_value: string;  // ISO date string OR bcrypt-like hash of code
  is_unlocked:  number;  // 0 | 1
  created_at:   string;
}

// ── DURABLE OBJECT ───────────────────────────────────────────────
export class VaultObject extends DurableObject {

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // init table on first access
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS vault (
        vault_id     TEXT PRIMARY KEY,
        sender       TEXT NOT NULL,
        recipient    TEXT NOT NULL,
        voice_id     TEXT NOT NULL,
        message_text TEXT NOT NULL,
        audio_r2_key TEXT NOT NULL,
        unlock_type  TEXT NOT NULL,
        unlock_value TEXT NOT NULL,
        is_unlocked  INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL
      )
    `);
  }

  // Called by the Worker to store vault data
  async create(data: Omit<VaultRow, 'is_unlocked' | 'created_at'>): Promise<void> {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO vault VALUES (?,?,?,?,?,?,?,?,0,?)`,
      data.vault_id, data.sender, data.recipient,
      data.voice_id, data.message_text, data.audio_r2_key,
      data.unlock_type, data.unlock_value, now
    );

    // If date-based, schedule alarm for that exact time
    if (data.unlock_type === 'date') {
      const unlockMs = new Date(data.unlock_value).getTime();
      if (unlockMs > Date.now()) {
        await this.ctx.storage.setAlarm(unlockMs);
      } else {
        // date already passed — unlock immediately
        this.ctx.storage.sql.exec(
          `UPDATE vault SET is_unlocked = 1 WHERE vault_id = ?`, data.vault_id
        );
      }
    }
  }

  // Alarm fires when date-based unlock time arrives
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE vault SET is_unlocked = 1`);
  }

  // Check status (public, no secret)
  async status(vaultId: string): Promise<{ unlock_type: string; is_unlocked: boolean } | null> {
    const rows = this.ctx.storage.sql
      .exec<VaultRow>(`SELECT unlock_type, is_unlocked FROM vault WHERE vault_id = ?`, vaultId)
      .toArray();
    if (!rows.length) return null;
    return { unlock_type: rows[0].unlock_type, is_unlocked: !!rows[0].is_unlocked };
  }

  // Attempt unlock — returns vault data if successful
  async unlock(vaultId: string, code: string): Promise<VaultRow | { error: string }> {
    const rows = this.ctx.storage.sql
      .exec<VaultRow>(`SELECT * FROM vault WHERE vault_id = ?`, vaultId)
      .toArray();

    if (!rows.length) return { error: 'Vault not found.' };

    const vault = rows[0];

    if (vault.unlock_type === 'date') {
      const now        = Date.now();
      const unlockTime = new Date(vault.unlock_value).getTime();
      if (now < unlockTime) {
        const formatted = new Date(vault.unlock_value).toLocaleDateString('en-GB', {
          year: 'numeric', month: 'long', day: 'numeric'
        });
        return { error: `This vault opens on ${formatted}. Come back then.` };
      }
      // Data passata — procedi senza codice
    } else {
      if (vault.unlock_value !== code.trim().toLowerCase()) {
        return { error: 'Incorrect code. The vault remains sealed.' };
      }
    }

    if (!vault.is_unlocked) {
      this.ctx.storage.sql.exec(
        `UPDATE vault SET is_unlocked = 1 WHERE vault_id = ?`, vaultId
      );
    }

    return vault;
  }
}
