// The page's tables that were in its database from before storage.db (server/agentbook.db), folded in with its store
// (server/main.ts, and agentbook-server's commands, which may run before it ever started). The relay's were in
// relay.db, folded in by the relay (server/relay.ts).

import { AccountTables } from "./accounts.ts";
import { BlobTables } from "./blobs.ts";
import { ConnectorTables } from "./connectors.ts";
import { DashboardTables } from "./dashboards.ts";

export const PAGE_TABLES = [AccountTables, BlobTables, DashboardTables, ConnectorTables];
