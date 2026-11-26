import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";

export const trpc = createTRPCProxyClient({
  links: [httpBatchLink({ url: "/trpc" })],
});
