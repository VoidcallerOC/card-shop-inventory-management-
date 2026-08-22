import InventoryItemPanel from "@/components/inventory/InventoryItemPanel";
import { CONDITIONS, isLowStock, itemName, PRODUCT_TYPES, titleCase } from "@/lib/inventory";
import { trpc } from "@/lib/trpc";
import { Box, ChevronRight, Filter, Loader2, PackagePlus, Search, SlidersHorizontal, TriangleAlert } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import type { AppRouter } from "../../../server/routers";

type RouterOutput = inferRouterOutputs<AppRouter>;
type InventoryItem = RouterOutput["inventory"]["list"][number];

export default function Inventory() {
  const [location, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  const [productType, setProductType] = useState<"all" | (typeof PRODUCT_TYPES)[number]>("all");
  const [condition, setCondition] = useState<"all" | (typeof CONDITIONS)[number]>("all");
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [selected, setSelected] = useState<InventoryItem | null | "new">(null);
  const filters = useMemo(() => ({ query: query || undefined, productType: productType === "all" ? undefined : productType, condition: condition === "all" ? undefined : condition, lowStockOnly }), [query, productType, condition, lowStockOnly]);
  const inventory = trpc.inventory.list.useQuery(filters);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("new") === "1") {
      setSelected("new");
      window.history.replaceState({}, "", "/inventory");
    }
  }, [location, setLocation]);

  const games = Array.from(new Set((inventory.data ?? []).map(item => item.game))).sort();

  return (
    <div className="page-shell">
      <div className="page-heading">
        <div><p className="eyebrow">Stock catalogue</p><h1>Inventory <span>control</span></h1><p>Search cleanly by card, set, SKU, condition, or product type. Every on-hand change belongs in the ledger.</p></div>
        <button onClick={() => setSelected("new")} className="button-primary"><PackagePlus size={17} /> Add inventory</button>
      </div>
      <section className="inventory-toolbar">
        <div className="search-field"><Search size={18} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search card, set, game, or SKU" /></div>
        <div className="filter-row"><Filter size={16} className="text-stone-400" /><select value={productType} onChange={event => setProductType(event.target.value as typeof productType)}><option value="all">All product types</option>{PRODUCT_TYPES.map(type => <option key={type} value={type}>{titleCase(type)}s</option>)}</select><select value={condition} onChange={event => setCondition(event.target.value as typeof condition)}><option value="all">All conditions</option>{CONDITIONS.map(item => <option key={item} value={item}>{titleCase(item)}</option>)}</select><button onClick={() => setLowStockOnly(current => !current)} className={`low-stock-filter ${lowStockOnly ? "is-active" : ""}`}><TriangleAlert size={15} /> Low stock</button></div>
      </section>
      {games.length > 0 && <div className="game-row"><span>Games in view</span>{games.map(game => <button key={game} onClick={() => setQuery(game)}>{game}</button>)}</div>}
      <section className="inventory-table-card">
        <div className="inventory-table-head"><div><span className="eyebrow">Live records</span><strong>{inventory.data?.length ?? 0} matching SKUs</strong></div><span className="table-helper"><SlidersHorizontal size={15} /> Condition-aware singles</span></div>
        {inventory.isLoading ? <div className="loading-panel"><Loader2 className="animate-spin" /> Loading inventory…</div> : inventory.data?.length ? <div className="table-wrap"><table><thead><tr><th>Item</th><th>Details</th><th>Location</th><th>On hand</th><th>Reorder</th><th aria-label="Open record"></th></tr></thead><tbody>{inventory.data.map(item => { const low = isLowStock(item); return <tr key={item.id} className="inventory-row" onClick={() => setSelected(item)}><td><div className="item-title"><div className={`item-icon ${item.productType}`}><Box size={17} /></div><div><strong>{itemName(item)}</strong><span>{item.sku}</span></div></div></td><td><div className="detail-stack"><span>{item.game} · {item.setName}</span><small>{item.productType === "single" ? `${titleCase(item.condition)}${item.variant ? ` · ${item.variant}` : ""}` : `${item.variant || "Sealed product"}`}</small></div></td><td><span className="location-chip">{item.storageLocation}</span></td><td><strong className={low ? "stock-low" : ""}>{item.onHand}</strong></td><td><span className={low ? "threshold-alert" : "threshold-normal"}>{item.reorderThreshold || "—"}</span></td><td><ChevronRight size={18} className="text-stone-400" /></td></tr>; })}</tbody></table></div> : <div className="empty-inventory"><Box size={26} /><h2>{query || lowStockOnly ? "No records match these filters" : "Your inventory starts here"}</h2><p>{query || lowStockOnly ? "Clear a filter or try another search term." : "Create the first single or sealed product record to begin tracking stock."}</p>{!query && !lowStockOnly && <button onClick={() => setSelected("new")} className="button-primary"><PackagePlus size={16} /> Add first record</button>}</div>}
      </section>
      {selected && <InventoryItemPanel item={selected === "new" ? null : selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
