# Project TODO

- [x] Establish an authenticated inventory dashboard with a persistent management sidebar and elegant visual system.
- [x] Add a stock overview, low-stock visibility, and recent inventory activity surface.
- [x] Model singles and sealed product inventory with game, set, card details, condition, variant, SKU, pricing, quantities, threshold, and storage location.
- [x] Implement searchable, filterable inventory with condition-aware rows and fast add/edit workflows.
- [x] Implement immutable stock movements and typed, concurrent-safe quantity-adjustment procedures.
- [x] Support attaching and retaining card, product, and condition-reference images using managed storage.
- [x] Notify the owner when tracked stock reaches or falls below its reorder threshold.
- [x] Create unit coverage for inventory mutations and stock movement integrity.
- [x] Validate the responsive interface, database migration, and dashboard flows.
- [x] Synchronize the completed implementation to the requested GitHub repository.
- [x] Add tRPC mutation coverage for adjustment success, stale-version conflict, and immutable ledger insertion.
- [x] Synchronize the implementation source into the requested `card-shop-inventory-management-` repository and push the completed commit.
- [x] Model and persist per-location on-hand balances for each inventory record.
- [x] Add concurrent-safe location-to-location transfer mutations that create auditable linked movements.
- [x] Make per-location stock, reorder risk, low-stock alert status, and alert history visible in inventory and dashboard views.
- [ ] Push the tested multi-location enhancement to the requested repository.
