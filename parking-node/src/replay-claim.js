// PD-08 replay fence. Uses the PD-02 inbox when present; never creates/deletes it.
function mountReplayClaim(app, { pool, internalKey }) {
  app.post("/api/internal/commands/replay-claim", async (req, res) => {
    if (req.get("x-internal-key") !== internalKey)
      return res.status(403).json({ error: "FORBIDDEN" });
    const { messageId, replayMessageId } = req.body ?? {};
    if (
      typeof messageId !== "string" ||
      messageId.length > 128 ||
      !messageId.includes(":") ||
      typeof replayMessageId !== "string" ||
      replayMessageId.length > 128 ||
      !replayMessageId.startsWith(`${messageId.split(":")[0]}:replay-`)
    )
      return res.status(400).json({ error: "INVALID_REPLAY_CLAIM" });
    const hash = `pd08-replay:${replayMessageId}`;
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await pool.checkEpoch?.(client);
      // Concurrent business INSERT must finish first. A committed result wins;
      // otherwise this tombstone prevents a delayed original from taking effect.
      await client.query(
        `INSERT INTO inbox_messages(message_id,command_type,request_hash,result,status_code,processed_at)
        VALUES($1,'replay_fence',$2,$3,422,now()) ON CONFLICT(message_id) DO NOTHING`,
        [
          messageId,
          hash,
          { error: "REPLACED_BY_ADMIN_REPLAY", replayMessageId },
        ],
      );
      const row = (
        await client.query(
          "SELECT request_hash FROM inbox_messages WHERE message_id=$1",
          [messageId],
        )
      ).rows[0];
      if (!row) throw new Error("INBOX_UNAVAILABLE");
      if (row.request_hash !== hash) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ error: "COMMAND_ALREADY_HAS_INBOX_RESULT" });
      }
      await pool.checkEpoch?.(client);
      await client.query("COMMIT");
      res.json({ claimed: true, replayMessageId });
    } catch {
      await client?.query("ROLLBACK").catch(() => {});
      res.status(503).json({ error: "INBOX_UNAVAILABLE" });
    } finally {
      client?.release();
    }
  });
}
module.exports = { mountReplayClaim };
