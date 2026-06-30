# Head Plan — AdaptiveWork Custom Panel

Getinge "Head Plan" panel for Planview AdaptiveWork (eu.clarizentb.com). A **read-only** project summary shown on **Work Items** (Project, Task, or Milestone). All data is sourced from the **owning project record**.

## Panel fields (paste each file into its editor field)

| Panel editor field | File |
|---|---|
| Data (JSON Format) | `HeadPlan.data.json` |
| HTML | `HeadPlan.html` |
| CSS / Style | `HeadPlan.css` |
| Script | `HeadPlan.js` |

## How it works

1. **Data field** supplies `{ sessionId, self:{SYSID,Project} }` via `JsonObject(CurrentObject(),"SYSID,Project")`.
   - `JsonObject` silently returns `{}` if *any* requested field is invalid — request only proven-valid fields.
2. **Script** derives the owning project id from `self.Project` (every work-item type carries a `Project` ref).
3. The project is fetched with the **objects API**: `GET /V2.0/services/data/objects/<id>?fields=...`.
   - CZQL cannot filter reliably on `id`; the objects API fetches by id.
   - Reference fields (PM, engineers) come back as `{id}` only, so their `Name` is resolved with a follow-up objects-API GET.
4. **Schedule dates** are not project fields — each is a Task found by **ExternalID**, reading its date:
   - ExternalID = `C_SAPProjectID` present ? `<C_SAPProjectID>_<code>` : `<projectSYSID>:<code>` (set by a workflow rule).
   - Per-cell date field via `data-datefield` (`DueDate` for finish dates, `StartDate` for start dates).
   - `WHERE ExternalID = '...'` *is* filterable in CZQL.

## Activity codes mapped so far

| Activity | Code | Date |
|---|---|---|
| PV Design | 1365 | DueDate |
| Mech Assembly | 0420 | StartDate |
| Electrical Assembly | 1840 | StartDate |
| PreQ | 1890 | StartDate |
| F.A.T | 0250 | StartDate |
| Unit Ready Date | 2055 | StartDate |
| Confirmed Delivery Date | 0630 | StartDate |

Still to map: Process, Electrical, Program (Design row); the whole Manufacturing – Chamber row; Testing (Assembly).

## Project field API names

Mapped: `C_ProductGESE`, `Country`, `C_BaiumCategory`, `C_OrderNumber`, `C_Customer`, `C_ProjectManager` (UserGroup ref), `C_ProcessEngineer`, `C_ElectricalEngineer`, `C_ControlEngineer`, `SYSID`.

Not yet mapped (render red "(field not mapped)"): Installation Country, Item No (First Level), Chamber Item No, RDD, Assembly Team, P-number, Mech Engineer, General comments, the two FAT reasons. Open: PM Email (`C_ProjectManager` is a UserGroup).

## Before go-live

- **Delete the red 🐞 Debug fieldset** from the HTML field (the `#hp-debug` block).
- Empty schedule cells render blank; unmapped display fields show red "(field not mapped)" as a remaining-work checklist.
