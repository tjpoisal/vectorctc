import { pgTable, text } from "drizzle-orm/pg-core";

export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(),
});
