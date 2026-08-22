import { trpc } from "@/lib/trpc";
import { centsToDollars, CONDITIONS, dollarsToCents, formatMoney, itemName, MOVEMENT_TYPES, PRODUCT_TYPES, titleCase } from "@/lib/inventory";
import { X, ImagePlus, Loader2, PackagePlus, History, Plus, Minus } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppRouter } from "../../../../server/routers";

type RouterOutput = inferRouterOutputs<AppRouter>;
type InventoryItem = RouterOutput["inventory"]["list"][number];

type ItemFormState = {
  productType: (typeof PRODUCT_TYPES)[number];
  game: string;
  setName: string;
  cardName: string;
  collectorNumber: string;
  condition: (typeof CONDITIONS)[number];
  variant: string;
  sku: string;
  purchasePrice: string;
  salePrice: string;
  onHand: string;
  reorderThreshold: string;
  storageLocation: string;
  notes: string;
};

function freshForm(): ItemFormState {
  return {
    productType: "single",
    game: "",
    setName: "",
    cardName: "",
    collectorNumber: "",
    condition: "near_mint",
    variant: "",
    sku: "",
    purchasePrice: "0.00",
    salePrice: "0.00",
    onHand: "0",
    reorderThreshold: "0",
    storageLocation: "",
    notes: "",
  };
}

function formFromItem(item: InventoryItem): ItemFormState {
  return {
    productType: item.productType,
    game: item.game,
    setName: item.setName,
    cardName: item.cardName ?? "",
    collectorNumber: item.collectorNumber ?? "",
    condition: item.condition,
    variant: item.variant ?? "",
    sku: item.sku,
    purchasePrice: centsToDollars(item.purchasePriceCents),
    salePrice: centsToDollars(item.salePriceCents),
    onHand: String(item.onHand),
    reorderThreshold: String(item.reorderThreshold),
    storageLocation: item.storageLocation,
    notes: item.notes ?? "",
  };
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.12em] text-stone-500">{children}</label>;
}

function Control(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`field-control ${props.className ?? ""}`} />;
}

export default function InventoryItemPanel({
  item,
  onClose,
}: {
  item: InventoryItem | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [liveItem, setLiveItem] = useState<InventoryItem | null>(item);
  const [form, setForm] = useState<ItemFormState>(() => (item ? formFromItem(item) : freshForm()));
  const [tab, setTab] = useState<"details" | "images" | "adjust">("details");
  const [adjustment, setAdjustment] = useState({ delta: "", movementType: "adjustment" as (typeof MOVEMENT_TYPES)[number], reason: "", reference: "" });
  const inputRef = useRef<HTMLInputElement>(null);
  const imagesQuery = trpc.inventory.images.useQuery({ inventoryItemId: item?.id ?? 0 }, { enabled: Boolean(item) });
  const createItem = trpc.inventory.create.useMutation({
    onSuccess: created => {
      toast.success(`${itemName(created)} is now in inventory.`);
      utils.inventory.invalidate();
      onClose();
    },
    onError: error => toast.error(error.message),
  });
  const updateItem = trpc.inventory.updateMetadata.useMutation({
    onSuccess: updated => {
      toast.success("Inventory details saved.");
      utils.inventory.invalidate();
      if (updated) {
        setLiveItem(updated);
        setForm(formFromItem(updated));
      }
    },
    onError: error => toast.error(error.message),
  });
  const adjustStock = trpc.inventory.adjustStock.useMutation({
    onSuccess: result => {
      toast.success("Stock movement recorded in the ledger.");
      setLiveItem(result.item);
      setAdjustment({ delta: "", movementType: "adjustment", reason: "", reference: "" });
      utils.inventory.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const attachImage = trpc.inventory.attachImage.useMutation({
    onSuccess: () => {
      toast.success("Reference image attached.");
      utils.inventory.images.invalidate();
    },
    onError: error => toast.error(error.message),
  });

  useEffect(() => {
    setLiveItem(item);
    setForm(item ? formFromItem(item) : freshForm());
    setTab("details");
  }, [item]);

  const setValue = <Key extends keyof ItemFormState>(key: Key, value: ItemFormState[Key]) => setForm(current => ({ ...current, [key]: value }));
  const currentItem = liveItem;

  function payload() {
    return {
      productType: form.productType,
      game: form.game.trim(),
      setName: form.setName.trim(),
      cardName: form.cardName.trim() || null,
      collectorNumber: form.collectorNumber.trim() || null,
      condition: form.productType === "sealed" ? "sealed" : form.condition,
      variant: form.variant.trim() || null,
      sku: form.sku.trim(),
      purchasePriceCents: dollarsToCents(form.purchasePrice),
      salePriceCents: dollarsToCents(form.salePrice),
      onHand: Math.max(0, Number.parseInt(form.onHand, 10) || 0),
      reorderThreshold: Math.max(0, Number.parseInt(form.reorderThreshold, 10) || 0),
      storageLocation: form.storageLocation.trim(),
      notes: form.notes.trim() || null,
    };
  }

  function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = payload();
    if (!values.game || !values.setName || !values.sku || !values.storageLocation) {
      toast.error("Game, set, SKU, and storage location are required.");
      return;
    }
    if (currentItem) {
      const { onHand: _onHand, ...metadata } = values;
      updateItem.mutate({ id: currentItem.id, expectedVersion: currentItem.version, ...metadata });
    } else {
      createItem.mutate(values);
    }
  }

  function recordAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentItem) return;
    const delta = Number.parseInt(adjustment.delta, 10);
    if (!Number.isInteger(delta) || delta === 0 || adjustment.reason.trim().length < 2) {
      toast.error("Add a non-zero quantity and a reason for this movement.");
      return;
    }
    adjustStock.mutate({
      inventoryItemId: currentItem.id,
      expectedVersion: currentItem.version,
      delta,
      movementType: adjustment.movementType,
      reason: adjustment.reason.trim(),
      reference: adjustment.reference.trim() || null,
    });
  }

  function handleImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !currentItem) return;
    if (!file.type.match(/^image\/(png|jpeg|webp|gif)$/)) {
      toast.error("Choose a PNG, JPEG, WebP, or GIF image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Images must be no larger than 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      attachImage.mutate({ inventoryItemId: currentItem.id, fileName: file.name, dataUrl: String(reader.result), caption: null });
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-[#17150f]/45 backdrop-blur-sm">
      <section aria-label="Inventory editor" className="panel-enter flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-[#ddd5c4] bg-[#faf8f3] shadow-2xl">
        <header className="flex items-start justify-between border-b border-[#e5dfd1] px-6 py-5">
          <div>
            <p className="eyebrow">{currentItem ? "Inventory record" : "New stock record"}</p>
            <h2 className="mt-1 font-display text-2xl text-[#252319]">{currentItem ? itemName(currentItem) : "Add to the vault"}</h2>
            {currentItem && <p className="mt-1 text-sm text-stone-500">{currentItem.sku} · {currentItem.onHand} on hand · {formatMoney(currentItem.salePriceCents)}</p>}
          </div>
          <button onClick={onClose} className="icon-button" aria-label="Close inventory editor"><X size={19} /></button>
        </header>

        {currentItem && (
          <nav className="flex gap-1 border-b border-[#e5dfd1] px-6 pt-3">
            {[
              { key: "details" as const, label: "Details", Icon: PackagePlus },
              { key: "images" as const, label: `Images ${imagesQuery.data?.length ? `(${imagesQuery.data.length})` : ""}`, Icon: ImagePlus },
              { key: "adjust" as const, label: "Adjust stock", Icon: History },
            ].map(({ key, label, Icon }) => (
              <button key={key} onClick={() => setTab(key)} className={`panel-tab ${tab === key ? "is-active" : ""}`}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </nav>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {tab === "details" && (
            <form onSubmit={saveDetails} className="space-y-6">
              <div className="rounded-2xl border border-[#e5dfd1] bg-white p-4">
                <div className="grid grid-cols-2 gap-3">
                  {PRODUCT_TYPES.map(type => (
                    <button type="button" key={type} onClick={() => setValue("productType", type)} className={`type-card ${form.productType === type ? "is-selected" : ""}`}>
                      <span className="font-semibold">{titleCase(type)}</span>
                      <span>{type === "single" ? "Condition-aware card record" : "Sealed product or accessory"}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div><FieldLabel>Game</FieldLabel><Control value={form.game} onChange={event => setValue("game", event.target.value)} placeholder="e.g. Magic: The Gathering" /></div>
                <div><FieldLabel>Set</FieldLabel><Control value={form.setName} onChange={event => setValue("setName", event.target.value)} placeholder="e.g. Modern Horizons 3" /></div>
                <div><FieldLabel>{form.productType === "sealed" ? "Product name" : "Card name"}</FieldLabel><Control value={form.cardName} onChange={event => setValue("cardName", event.target.value)} placeholder={form.productType === "sealed" ? "Collector Booster Box" : "Sheoldred, the Apocalypse"} /></div>
                <div><FieldLabel>SKU</FieldLabel><Control value={form.sku} onChange={event => setValue("sku", event.target.value)} placeholder="MTG-MH3-CBB-001" /></div>
                {form.productType === "single" && <><div><FieldLabel>Condition</FieldLabel><select value={form.condition} onChange={event => setValue("condition", event.target.value as ItemFormState["condition"])} className="field-control">{CONDITIONS.filter(condition => condition !== "sealed").map(condition => <option key={condition} value={condition}>{titleCase(condition)}</option>)}</select></div><div><FieldLabel>Collector number</FieldLabel><Control value={form.collectorNumber} onChange={event => setValue("collectorNumber", event.target.value)} placeholder="150" /></div></>}
                <div><FieldLabel>Variant</FieldLabel><Control value={form.variant} onChange={event => setValue("variant", event.target.value)} placeholder="Foil, extended art, first edition…" /></div>
                <div><FieldLabel>Storage location</FieldLabel><Control value={form.storageLocation} onChange={event => setValue("storageLocation", event.target.value)} placeholder="Case A · Row 3 · Slot 12" /></div>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div><FieldLabel>Cost</FieldLabel><div className="money-input"><span>$</span><Control type="number" min="0" step="0.01" value={form.purchasePrice} onChange={event => setValue("purchasePrice", event.target.value)} /></div></div>
                <div><FieldLabel>Sale price</FieldLabel><div className="money-input"><span>$</span><Control type="number" min="0" step="0.01" value={form.salePrice} onChange={event => setValue("salePrice", event.target.value)} /></div></div>
                {!currentItem && <div><FieldLabel>Opening quantity</FieldLabel><Control type="number" min="0" step="1" value={form.onHand} onChange={event => setValue("onHand", event.target.value)} /></div>}
                <div><FieldLabel>Reorder threshold</FieldLabel><Control type="number" min="0" step="1" value={form.reorderThreshold} onChange={event => setValue("reorderThreshold", event.target.value)} /></div>
              </div>
              <div><FieldLabel>Notes</FieldLabel><textarea value={form.notes} onChange={event => setValue("notes", event.target.value)} className="field-control min-h-24 resize-y" placeholder="Grading notes, supplier details, special handling…" /></div>
              <div className="flex justify-end gap-3 border-t border-[#e5dfd1] pt-5"><button type="button" onClick={onClose} className="button-secondary">Cancel</button><button type="submit" disabled={createItem.isPending || updateItem.isPending} className="button-primary">{(createItem.isPending || updateItem.isPending) && <Loader2 size={16} className="animate-spin" />}{currentItem ? "Save details" : "Create inventory record"}</button></div>
            </form>
          )}

          {tab === "images" && currentItem && (
            <div className="space-y-5">
              <div className="rounded-2xl border border-dashed border-[#c7bba4] bg-[#f5f0e6] p-6 text-center">
                <ImagePlus className="mx-auto mb-3 text-[#806d4d]" size={28} />
                <h3 className="font-display text-lg text-[#252319]">Attach visual references</h3>
                <p className="mx-auto mt-1 max-w-sm text-sm text-stone-500">Keep card fronts, sealed product photos, and condition-reference images with this record.</p>
                <input ref={inputRef} className="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleImage} />
                <button onClick={() => inputRef.current?.click()} disabled={attachImage.isPending} className="button-secondary mt-4">{attachImage.isPending ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={16} />} Upload image</button>
              </div>
              {imagesQuery.isLoading ? <div className="flex justify-center py-10"><Loader2 className="animate-spin text-[#806d4d]" /></div> : imagesQuery.data?.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{imagesQuery.data.map(image => <a href={image.url} target="_blank" rel="noreferrer" key={image.id} className="group overflow-hidden rounded-xl border border-[#e5dfd1] bg-white"><div className="aspect-square overflow-hidden bg-[#eee8dc]"><img src={image.url} alt={image.caption || image.fileName} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" /></div><p className="truncate px-3 py-2 text-xs text-stone-500">{image.fileName}</p></a>)}</div> : <div className="empty-state">No reference images are attached yet.</div>}
            </div>
          )}

          {tab === "adjust" && currentItem && (
            <form onSubmit={recordAdjustment} className="space-y-5">
              <div className="ledger-note"><History size={18} /><div><strong>Every adjustment creates a permanent ledger entry.</strong><span>Stock is version-checked before it changes, so concurrent edits never silently overwrite another staff member’s update.</span></div></div>
              <div className="rounded-2xl border border-[#e5dfd1] bg-white p-5"><p className="eyebrow">Current balance</p><p className="mt-1 font-display text-5xl text-[#252319]">{currentItem.onHand}<span className="ml-2 text-base font-sans font-medium text-stone-400">on hand</span></p><p className="mt-2 text-sm text-stone-500">Reorder alert at {currentItem.reorderThreshold || "not tracked"} units · Version {currentItem.version}</p></div>
              <div className="grid gap-4 sm:grid-cols-2"><div><FieldLabel>Quantity change</FieldLabel><div className="quantity-control"><button type="button" onClick={() => setAdjustment(current => ({ ...current, delta: String((Number(current.delta) || 0) - 1) }))}><Minus size={15} /></button><Control type="number" step="1" value={adjustment.delta} onChange={event => setAdjustment(current => ({ ...current, delta: event.target.value }))} placeholder="+0" /><button type="button" onClick={() => setAdjustment(current => ({ ...current, delta: String((Number(current.delta) || 0) + 1) }))}><Plus size={15} /></button></div></div><div><FieldLabel>Movement type</FieldLabel><select value={adjustment.movementType} onChange={event => setAdjustment(current => ({ ...current, movementType: event.target.value as typeof current.movementType }))} className="field-control">{MOVEMENT_TYPES.map(type => <option value={type} key={type}>{titleCase(type)}</option>)}</select></div></div>
              <div><FieldLabel>Reason</FieldLabel><Control value={adjustment.reason} onChange={event => setAdjustment(current => ({ ...current, reason: event.target.value }))} placeholder="e.g. POS sale, distributor delivery, cycle count" /></div>
              <div><FieldLabel>Reference (optional)</FieldLabel><Control value={adjustment.reference} onChange={event => setAdjustment(current => ({ ...current, reference: event.target.value }))} placeholder="Receipt, invoice, order, or count ID" /></div>
              <div className="flex justify-end border-t border-[#e5dfd1] pt-5"><button type="submit" disabled={adjustStock.isPending} className="button-primary">{adjustStock.isPending && <Loader2 size={16} className="animate-spin" />}Record movement</button></div>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
