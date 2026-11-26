import { useQuery } from "@tanstack/react-query";

export function useInvoices() {
  return useQuery({
    queryKey: ["invoices"],
    queryFn: () => Promise.resolve([]),
  });
}
