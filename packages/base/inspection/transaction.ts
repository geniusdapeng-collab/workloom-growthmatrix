import type pg from "pg";

export interface InspectionScope { tenantId: string; workspaceId: string }

/** One connection, both RLS keys and an observed commit before returning a result. */
export async function withInspectionTransaction<T>(
  app: pg.Pool,
  scope: InspectionScope,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.connect();
  let discard = false;
  try {
    // A waiter must read the winner's committed event after acquiring the anomaly lock.
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      discard = true;
      throw new AggregateError([error, rollbackError], "巡检事务回退失败，连接已弃用", { cause: error });
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
