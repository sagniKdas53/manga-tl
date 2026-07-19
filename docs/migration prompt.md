# Prompt for migration

Use the `grill-me` and `improve-codebase-architecture` skills to analyze the Phase D plan provided below.

Before modifying any files:

1. Conduct the relentless planning interview (`grill-me`) to surface hidden edge cases, state management conflicts, or missing Material UI imports in this plan.
2. Focus deeply on Phase D.12 (MUI Migration) and Phase D.14 (React.memo) to ensure we preserve our existing frontend state and application performance.
3. Make sure to use the `material-ui-theming` skill to ensure the Material UI components are styled according to our theme.
4. Make sure to use the `improve-codebase-architecture` skill to ensure the codebase architecture is improved.
5. While do the migration don't just change out the components for their material ui alternative, spend some time analyzing how to best leverage the current designs features into the material ui alternative.
6. Also make sure all the best practices are followed as outlined by `vercel-react-best-practices`, `web-design-guidelines`, and `frontend-design`.
7. Make sure the we are not changing the logic of the API's or components, just the UI.
8. Make sure the tests are upgraded as not just changed to fit the new shape of the UI.

Here is the plan to audit:

Phase D of docs/plan-improvements.md

---
At chapter page
<button class="btn btn-secondary" style="padding: 8px 16px; margin-bottom: 16px;">← Back to Series</button><div class="page-header"><div><div style="display: flex; align-items: center; gap: 12px;"><h1>Chapter 1</h1><button class="action-btn-small" title="Edit Chapter Name &amp; Number" style="background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; padding: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; color: var(--text-muted); transition: 0.2s;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button></div><p style="color: var(--text-muted); margin: 8px 0px 0px;">17thJune / One</p></div><div style="display: flex; gap: 12px;"><button class="btn btn-secondary">Import Project (ZIP)</button><button class="btn btn-secondary">Export Chapter (ZIP)</button><button class="btn btn-primary">Upload Page</button></div></div>

At series page

<button class="btn btn-secondary" style="padding: 8px 16px; margin-bottom: 16px;">← Back to Library</button>

And

<div class="series-cover-column"><img class="series-large-cover" alt="17thJune" src="/tlhub/api/images/09b29432-f430-4020-8ed1-5376a50c2c0d/thumbnail"></div><div class="series-info-column"><h1 class="series-title">17thJune</h1><div class="nhentai-meta-table"><div class="meta-row"><span class="meta-label">Language:</span><span class="meta-value"><span class="meta-badge-nhentai">ja → en</span></span></div><div class="meta-row"><span class="meta-label">Direction:</span><span class="meta-value"><span class="meta-badge-nhentai">rtl</span></span></div><div class="meta-row"><span class="meta-label">Chapters:</span><span class="meta-value">1</span></div></div><div class="series-actions-row"><button class="btn-nhentai btn-nhentai-primary"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>Add Chapter</button><button class="btn-nhentai btn-nhentai-secondary"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>Import Chapter (ZIP/ePub)</button><button class="btn-nhentai btn-nhentai-secondary">Edit Series</button><button class="btn-nhentai btn-nhentai-danger">Delete Series</button></div></div>


---

<div class="mb-8"><button class="MuiButtonBase-root MuiButton-root MuiButton-outlined MuiButton-sizeSmall MuiButton-colorPrimary css-1khhpdb-MuiButtonBase-root-MuiButton-root" tabindex="0" type="button">← Back to Series</button><div class="page-header"><div><div style="display: flex; align-items: center; gap: 12px;"><h1>Chapter 1</h1><button class="MuiButtonBase-root MuiIconButton-root MuiIconButton-sizeSmall css-155wbr6-MuiButtonBase-root-MuiIconButton-root" tabindex="0" type="button" title="Edit Chapter Name &amp; Number"><svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeSmall css-120dh41-MuiSvgIcon-root" focusable="false" aria-hidden="true" viewBox="0 0 24 24" data-testid="EditIcon"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"></path></svg><span class="MuiTouchRipple-root css-r3djoj-MuiTouchRipple-root"></span></button></div><p style="color: var(--text-muted); margin: 8px 0px 0px;">SFW / Test1</p></div><div class="MuiStack-root css-niqf4j-MuiStack-root"><button class="MuiButtonBase-root MuiButton-root MuiButton-outlined MuiButton-sizeSmall MuiButton-colorPrimary css-7wcz78-MuiButtonBase-root-MuiButton-root" tabindex="0" type="button">Import Project (ZIP)</button><button class="MuiButtonBase-root MuiButton-root MuiButton-outlined MuiButton-sizeSmall MuiButton-colorPrimary css-7wcz78-MuiButtonBase-root-MuiButton-root" tabindex="0" type="button">Export Chapter (ZIP)</button><button class="MuiButtonBase-root MuiButton-root MuiButton-contained MuiButton-sizeSmall MuiButton-colorPrimary css-vut4ef-MuiButtonBase-root-MuiButton-root" tabindex="0" type="button">Upload Page</button></div></div></div>