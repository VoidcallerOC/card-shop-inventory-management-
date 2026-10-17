import { CONDITIONS, centsToDollars, dollarsToCents, formatMoney, titleCase } from "@/lib/inventory";
import { trpc } from "@/lib/trpc";
import {
  buildIntakeDraftLines,
  parseShopIntakeJson,
  suggestSku,
  type IntakeDraftLine,
  type InventoryCondition,
} from "@shared/shopIntake";
import { CheckCircle2, FileJson2, Loader2, Upload, XCircle } from "lucide-react";
import { ChangeEvent, useMemo, useState } from "react";
import { toast } from "sonner";

type ReviewLine = IntakeDraftLine & {
  alreadyApplied?: boolean;
  matchSuggestions?: Array<{
    id: number;
    sku: string;
    cardName: string | null;
    setName: string;
    game: string;
    condition: string;
    onHand: number;
    version: number;
  }>;
  inventoryLocationId?: number | null;
  expectedVersion?: number | null;
  expectedLocationVersion?: number | null;
};

type ConfirmResult = {
  results: Array<{ lineId: string; status: string; message: string; inventoryItemId: number | null }>;
  applied: number;
  skipped: number;
  failed: number;
};

export default function ShopIntakeImport() {
  const utils = trpc.useUtils();
  const [rawJson, setRawJson] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [defaults, setDefaults] = useState({ game: "", setName: "", storageLocation: "Intake" });
  const [lines, setLines] = useState<ReviewLine[]>([]);
  const [exportedAt, setExportedAt] = useState<string | null>(null);
  const [clientLabel, setClientLabel] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ count: number; priced: number; unpriced: number; offerCents: number } | null>(
    null,
  );
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null);
  const [phase, setPhase] = useState<"upload" | "review" | "done">("upload");

  const preview = trpc.inventory.previewShopIntake.useMutation({
    onError: error => toast.error(error.message),
  });
  const confirm = trpc.inventory.confirmShopIntake.useMutation({
    onError: error => toast.error(error.message),
  });
  const includedCount = useMemo(() => lines.filter(line => line.included).length, [lines]);
  const blockingIssues = useMemo(
    () =>
      lines
        .filter(line => line.included)
        .flatMap(line => {
          const issues = [...line.issues];
          if (!line.condition) issues.push("Condition required");
          if (!line.game.trim()) issues.push("Game required");
          if (!line.setName.trim()) issues.push("Set required");
          if (!line.sku.trim()) issues.push("SKU required");
          if (!line.storageLocation.trim()) issues.push("Location required");
          if (line.matchMode === "receive" && !line.matchedInventoryItemId) issues.push("Match required");
          if (line.matchMode === "receive" && !line.inventoryLocationId) issues.push("Pick a receive location");
          return issues.map(issue => `${line.sourceKey}: ${issue}`);
        }),
    [lines],
  );

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      toast.error("Upload a .json shop intake export.");
      return;
    }
    const text = await file.text();
    const local = parseShopIntakeJson(text);
    if (!local.ok) {
      toast.error(local.error);
      return;
    }
    setRawJson(text);
    setFileName(file.name);
    setConfirmResult(null);
    setPhase("upload");
    toast.success(`Loaded ${file.name}. Set defaults, then preview.`);
  }

  async function runPreview() {
    if (!rawJson) return toast.error("Choose a shop intake JSON file first.");
    const local = parseShopIntakeJson(rawJson);
    if (!local.ok) return toast.error(local.error);

    // Local draft first (zero network side effects beyond the read-only preview call).
    const draft = buildIntakeDraftLines(local.payload, defaults);
    setLines(draft);
    setExportedAt(local.payload.exportedAt);
    setClientLabel(local.payload.client.businessName ?? local.payload.client.clientId ?? "Unknown client");
    setSummary(local.payload.summary);

    const result = await preview.mutateAsync({ rawJson, defaults });
    setExportedAt(result.exportedAt);
    setClientLabel(result.client.businessName ?? result.client.clientId ?? "Unknown client");
    setSummary(result.summary);
    setLines(
      result.lines.map(line => ({
        ...line,
        inventoryLocationId: null,
        expectedVersion: null,
        expectedLocationVersion: null,
      })),
    );
    setPhase("review");
    toast.success("Preview ready — no inventory changes were written.");
  }

  function updateLine(lineId: string, patch: Partial<ReviewLine>) {
    setLines(current =>
      current.map(line => {
        if (line.lineId !== lineId) return line;
        const next = { ...line, ...patch };
        if (
          patch.game !== undefined ||
          patch.setName !== undefined ||
          patch.collectorNumber !== undefined ||
          patch.condition !== undefined
        ) {
          if (next.matchMode === "create" && next.game && next.setName && next.condition) {
            next.sku = suggestSku({
              game: next.game,
              setName: next.setName,
              collectorNumber: next.collectorNumber,
              condition: next.condition,
            });
          }
        }
        next.issues = [];
        if (!next.condition) next.issues.push("Condition needs staff mapping.");
        if (!next.cardName.trim()) next.issues.push("Card name is empty.");
        if (!next.game.trim()) next.issues.push("Game is required.");
        if (!next.setName.trim()) next.issues.push("Set is required.");
        if (!next.storageLocation.trim()) next.issues.push("Storage location is required.");
        if (!next.sku.trim()) next.issues.push("SKU is required.");
        return next;
      }),
    );
  }

  async function chooseMatch(line: ReviewLine, matchId: number) {
    const suggestion = line.matchSuggestions?.find(entry => entry.id === matchId);
    if (!suggestion) return;
    const locations = await utils.inventory.locations.fetch({ inventoryItemId: matchId });
    const primary = locations.find(entry => entry.isPrimary) ?? locations[0];
    updateLine(line.lineId, {
      matchMode: "receive",
      matchedInventoryItemId: matchId,
      sku: suggestion.sku,
      game: suggestion.game,
      setName: suggestion.setName,
      cardName: suggestion.cardName ?? line.cardName,
      condition: suggestion.condition as InventoryCondition,
      inventoryLocationId: primary?.id ?? null,
      expectedVersion: suggestion.version,
      expectedLocationVersion: primary?.version ?? null,
      storageLocation: primary?.name ?? line.storageLocation,
    });
  }

  async function runConfirm() {
    if (!exportedAt) return;
    if (blockingIssues.length) {
      toast.error("Resolve review issues before confirming.");
      return;
    }
    if (!includedCount) {
      toast.error("Include at least one line.");
      return;
    }

    const payload = {
      exportedAt,
      lines: lines.map(line => ({
        lineId: line.lineId,
        sourceKey: line.sourceKey,
        included: line.included,
        matchMode: line.matchMode,
        matchedInventoryItemId: line.matchedInventoryItemId,
        inventoryLocationId: line.inventoryLocationId ?? null,
        expectedVersion: line.expectedVersion ?? null,
        expectedLocationVersion: line.expectedLocationVersion ?? null,
        productType: line.productType,
        game: line.game.trim(),
        setName: line.setName.trim(),
        cardName: line.cardName.trim(),
        collectorNumber: line.collectorNumber,
        condition: line.condition,
        variant: line.variant,
        sku: line.sku.trim(),
        purchasePriceCents: line.offerCents,
        salePriceCents: line.referenceCents,
        quantity: line.quantity,
        reorderThreshold: line.reorderThreshold,
        storageLocation: line.storageLocation.trim(),
        notes: line.notes || null,
      })),
    };

    const result = await confirm.mutateAsync(payload);
    setConfirmResult(result);
    setPhase("done");
    await utils.inventory.list.invalidate();
    await utils.inventory.dashboard.invalidate();
    await utils.inventory.movementHistory.invalidate();
    toast.success(`Import finished: ${result.applied} applied, ${result.skipped} skipped, ${result.failed} failed.`);
  }

  return (
    <div className="page-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Scanner handoff</p>
          <h1>
            Shop intake <span>import</span>
          </h1>
          <p>
            Upload a local shop-intake JSON export, review every line, then explicitly confirm. Preview never writes
            stock. Confirm uses existing create / receive ledger paths only.
          </p>
        </div>
      </div>

      <section className="inventory-table-card" style={{ marginBottom: 16 }}>
        <div className="inventory-table-head">
          <div>
            <span className="eyebrow">Step 1 · Local file</span>
            <strong>Upload export JSON</strong>
          </div>
          <span className="table-helper">
            <FileJson2 size={15} /> schema tcg-buy-calculator.shop-intake.v1
          </span>
        </div>
        <div className="p-5 space-y-4">
          <label className="flex cursor-pointer flex-col items-center gap-3 rounded-2xl border border-dashed border-[#c7bba4] bg-[#f5f0e6] px-6 py-10 text-center">
            <Upload className="text-[#806d4d]" size={28} />
            <div>
              <strong className="block text-[#252319]">Choose shop-intake-*.json</strong>
              <span className="mt-1 block text-sm text-stone-500">Local upload only. No scanner rebuild or remote pull.</span>
            </div>
            <input type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
            {fileName && <span className="font-mono text-xs text-[#6d582e]">{fileName}</span>}
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="eyebrow">Default game</label>
              <input
                className="field-control mt-1"
                value={defaults.game}
                onChange={event => setDefaults(current => ({ ...current, game: event.target.value }))}
                placeholder="One Piece"
              />
            </div>
            <div>
              <label className="eyebrow">Default set</label>
              <input
                className="field-control mt-1"
                value={defaults.setName}
                onChange={event => setDefaults(current => ({ ...current, setName: event.target.value }))}
                placeholder="OP-09"
              />
            </div>
            <div>
              <label className="eyebrow">Default intake location</label>
              <input
                className="field-control mt-1"
                value={defaults.storageLocation}
                onChange={event => setDefaults(current => ({ ...current, storageLocation: event.target.value }))}
                placeholder="Intake"
              />
            </div>
          </div>

          <button onClick={runPreview} disabled={!rawJson || preview.isPending} className="button-primary">
            {preview.isPending ? <Loader2 size={16} className="animate-spin" /> : <FileJson2 size={16} />}
            Preview import (no writes)
          </button>
        </div>
      </section>

      {phase !== "upload" && summary && (
        <section className="ledger-banner">
          <FileJson2 size={18} />
          <div>
            <strong>
              {clientLabel} · {summary.count} cards · offer {formatMoney(summary.offerCents)}
            </strong>
            <p>
              Exported {exportedAt}. Priced {summary.priced}, unpriced {summary.unpriced}. Review below before any
              ledger write.
            </p>
          </div>
        </section>
      )}

      {phase === "review" && (
        <section className="inventory-table-card">
          <div className="inventory-table-head">
            <div>
              <span className="eyebrow">Step 2 · Staff review</span>
              <strong>
                {includedCount} line{includedCount === 1 ? "" : "s"} selected
              </strong>
            </div>
            <button
              onClick={runConfirm}
              disabled={confirm.isPending || blockingIssues.length > 0 || includedCount === 0}
              className="button-primary"
            >
              {confirm.isPending ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
              Confirm import
            </button>
          </div>

          {blockingIssues.length > 0 && (
            <div className="mx-5 mb-3 rounded-xl border border-[#dba79d] bg-[#fbebe7] px-4 py-3 text-sm text-[#a44535]">
              Fix {blockingIssues.length} issue{blockingIssues.length === 1 ? "" : "s"} before confirm. First:{" "}
              {blockingIssues[0]}
            </div>
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Include</th>
                  <th>Card</th>
                  <th>Mapping</th>
                  <th>Money / qty</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {lines.map(line => (
                  <tr key={line.lineId} className="inventory-row" style={{ cursor: "default" }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={line.included}
                        onChange={event => updateLine(line.lineId, { included: event.target.checked })}
                      />
                      {line.alreadyApplied && (
                        <span className="mt-2 block text-[10px] font-bold text-[#806d4d]">Already applied</span>
                      )}
                    </td>
                    <td>
                      <div className="detail-stack">
                        <strong className="text-sm text-[#393629]">{line.label}</strong>
                        <small>
                          Source condition: {line.sourceCondition}
                          {line.unavailable ? ` · ${line.unavailable}` : ""}
                        </small>
                        <input
                          className="field-control mt-2"
                          value={line.cardName}
                          onChange={event => updateLine(line.lineId, { cardName: event.target.value })}
                          placeholder="Card name"
                        />
                        <input
                          className="field-control mt-2"
                          value={line.collectorNumber ?? ""}
                          onChange={event =>
                            updateLine(line.lineId, { collectorNumber: event.target.value || null })
                          }
                          placeholder="Collector #"
                        />
                      </div>
                    </td>
                    <td>
                      <div className="grid gap-2">
                        <input
                          className="field-control"
                          value={line.game}
                          onChange={event => updateLine(line.lineId, { game: event.target.value })}
                          placeholder="Game"
                        />
                        <input
                          className="field-control"
                          value={line.setName}
                          onChange={event => updateLine(line.lineId, { setName: event.target.value })}
                          placeholder="Set"
                        />
                        <select
                          className="field-control"
                          value={line.condition ?? ""}
                          onChange={event =>
                            updateLine(line.lineId, {
                              condition: (event.target.value || null) as InventoryCondition | null,
                            })
                          }
                        >
                          <option value="">Condition…</option>
                          {CONDITIONS.map(condition => (
                            <option key={condition} value={condition}>
                              {titleCase(condition)}
                            </option>
                          ))}
                        </select>
                        <input
                          className="field-control"
                          value={line.sku}
                          onChange={event => updateLine(line.lineId, { sku: event.target.value })}
                          placeholder="SKU"
                        />
                        <input
                          className="field-control"
                          value={line.storageLocation}
                          onChange={event => updateLine(line.lineId, { storageLocation: event.target.value })}
                          placeholder="Location"
                        />
                      </div>
                    </td>
                    <td>
                      <div className="grid gap-2">
                        <label className="text-[10px] text-stone-500">
                          Buy (offer)
                          <input
                            className="field-control mt-1"
                            value={centsToDollars(line.offerCents)}
                            onChange={event =>
                              updateLine(line.lineId, { offerCents: dollarsToCents(event.target.value) })
                            }
                          />
                        </label>
                        <label className="text-[10px] text-stone-500">
                          Sale (market)
                          <input
                            className="field-control mt-1"
                            value={centsToDollars(line.referenceCents)}
                            onChange={event =>
                              updateLine(line.lineId, { referenceCents: dollarsToCents(event.target.value) })
                            }
                          />
                        </label>
                        <label className="text-[10px] text-stone-500">
                          Qty
                          <input
                            className="field-control mt-1"
                            type="number"
                            min={1}
                            value={line.quantity}
                            onChange={event =>
                              updateLine(line.lineId, {
                                quantity: Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                              })
                            }
                          />
                        </label>
                      </div>
                    </td>
                    <td>
                      <div className="grid gap-2">
                        <select
                          className="field-control"
                          value={line.matchMode}
                          onChange={event =>
                            updateLine(line.lineId, {
                              matchMode: event.target.value as "create" | "receive",
                              matchedInventoryItemId:
                                event.target.value === "create" ? null : line.matchedInventoryItemId,
                            })
                          }
                        >
                          <option value="create">Create new SKU</option>
                          <option value="receive">Receive into existing</option>
                        </select>
                        {line.matchSuggestions && line.matchSuggestions.length > 0 && (
                          <div className="space-y-1">
                            <span className="text-[10px] font-bold text-[#806d4d]">Suggestions</span>
                            {line.matchSuggestions.map(match => (
                              <button
                                key={match.id}
                                type="button"
                                className="button-secondary w-full justify-start text-left text-[11px]"
                                onClick={() => void chooseMatch(line, match.id)}
                              >
                                {match.sku} · {match.onHand} on hand
                              </button>
                            ))}
                          </div>
                        )}
                        {line.matchMode === "receive" && line.matchedInventoryItemId && (
                          <ReceiveLocationPicker
                            inventoryItemId={line.matchedInventoryItemId}
                            selectedLocationId={line.inventoryLocationId ?? null}
                            onPick={(locationId, version, locationVersion, name) =>
                              updateLine(line.lineId, {
                                inventoryLocationId: locationId,
                                expectedVersion: version,
                                expectedLocationVersion: locationVersion,
                                storageLocation: name,
                              })
                            }
                          />
                        )}
                        {line.issues.length > 0 && (
                          <span className="text-[10px] text-[#a44535]">{line.issues.join(" ")}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {phase === "done" && confirmResult && (
        <section className="inventory-table-card">
          <div className="inventory-table-head">
            <div>
              <span className="eyebrow">Step 3 · Result</span>
              <strong>
                {confirmResult.applied} applied · {confirmResult.skipped} skipped · {confirmResult.failed} failed
              </strong>
            </div>
            <button
              className="button-secondary"
              onClick={() => {
                setPhase("upload");
                setLines([]);
                setRawJson(null);
                setFileName(null);
                setConfirmResult(null);
              }}
            >
              Import another file
            </button>
          </div>
          <div className="activity-list">
            {confirmResult.results.map(result => (
              <div className="activity-row" key={result.lineId}>
                <div className={`activity-arrow ${result.status === "failed" ? "outbound" : "inbound"}`}>
                  {result.status === "failed" ? <XCircle size={15} /> : <CheckCircle2 size={15} />}
                </div>
                <div>
                  <strong>{result.status}</strong>
                  <span>
                    {result.message}
                    {result.inventoryItemId ? ` · item #${result.inventoryItemId}` : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ReceiveLocationPicker({
  inventoryItemId,
  selectedLocationId,
  onPick,
}: {
  inventoryItemId: number;
  selectedLocationId: number | null;
  onPick: (locationId: number, itemVersion: number, locationVersion: number, name: string) => void;
}) {
  const itemQuery = trpc.inventory.get.useQuery({ id: inventoryItemId });
  const query = trpc.inventory.locations.useQuery({ inventoryItemId });
  if (query.isLoading || itemQuery.isLoading) {
    return (
      <div className="flex justify-center py-2">
        <Loader2 className="animate-spin text-[#806d4d]" size={16} />
      </div>
    );
  }
  return (
    <select
      className="field-control"
      value={selectedLocationId ?? ""}
      onChange={event => {
        const location = query.data?.find(entry => entry.id === Number(event.target.value));
        if (!location || !itemQuery.data) return;
        onPick(location.id, itemQuery.data.version, location.version, location.name);
      }}
    >
      <option value="">Receive location…</option>
      {query.data?.map(location => (
        <option key={location.id} value={location.id}>
          {location.name} ({location.onHand})
        </option>
      ))}
    </select>
  );
}
