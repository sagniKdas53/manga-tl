const fs = require('fs');
let code = fs.readFileSync('frontend/src/components/Reader.tsx', 'utf8');

// 1. Add imports
code = code.replace(
  'import JSZip from "jszip";\nimport {',
  'import JSZip from "jszip";\nimport Box from "@mui/material/Box";\nimport Drawer from "@mui/material/Drawer";\nimport Paper from "@mui/material/Paper";\nimport AppBar from "@mui/material/AppBar";\nimport Toolbar from "@mui/material/Toolbar";\nimport IconButton from "@mui/material/IconButton";\nimport Typography from "@mui/material/Typography";\nimport ArrowBackIcon from "@mui/icons-material/ArrowBack";\nimport SettingsIcon from "@mui/icons-material/Settings";\nimport InfoIcon from "@mui/icons-material/Info";\nimport {'
);

// 2. Loading state container
code = code.replace(
  `<div\n        className="reader-container-nhentai"\n        style={{ alignItems: "center", justifyContent: "center" }}\n      >`,
  `<Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', alignItems: "center", justifyContent: "center", bgcolor: 'background.default' }}>`
);
// Loading state end
code = code.replace(
  `        <p>Loading page...</p>\n      </div>\n    );\n  }`,
  `        <p>Loading page...</p>\n      </Box>\n    );\n  }`
);

// 3. Main wrapper
code = code.replace(
  `  return (\n    <div className="reader-container-nhentai">\n      {/* Top Navbar */}`,
  `  return (\n    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', bgcolor: 'background.default' }}>\n      {/* Top Navbar */}`
);

// 4. Navbar start to Navbar end
const navbarStart = `      <div\n        className="reader-navbar-nhentai"`;
const navbarEndString = `              <line\n                x1="15"\n                y1="3"\n                x2="15"\n                y2="21"\n              />\n            </svg>\n          </button>\n        </div>\n      </div>`;

const idxStart = code.indexOf(navbarStart);
const idxEnd = code.indexOf(navbarEndString) + navbarEndString.length;

if (idxStart !== -1 && idxEnd > idxStart) {
  const newNavbar = `      <AppBar position="static" color="default" elevation={1} sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}>
        <Toolbar variant="dense" sx={{ justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <IconButton color="inherit" onClick={() => navigate(\`/chapters/\${selectedChapter ? selectedChapter.id : ""}/\${selectedChapter ? toSlug(selectedChapter.title || \`chapter-\${selectedChapter.chapterNumber}\`) : ""}\`)} title="Back to Chapter" size="small">
              <ArrowBackIcon />
            </IconButton>

            <IconButton color={showLeftSidebar ? "primary" : "inherit"} onClick={() => setShowLeftSidebar((prev) => !prev)} title="Toggle Global Controls (Left Sidebar)" size="small">
              <SettingsIcon />
            </IconButton>
          </Box>

          <Typography variant="subtitle2" noWrap sx={{ fontWeight: 600, fontFamily: "var(--font-display)", maxWidth: "50%" }}>
            {selectedSeries ? selectedSeries.title : "Series"} &mdash; Chapter {selectedChapter?.chapterNumber}
          </Typography>

          <IconButton color={showRightSidebar ? "primary" : "inherit"} onClick={() => setShowRightSidebar((prev) => !prev)} title="Toggle Property Inspector (Right Sidebar)" size="small">
            <InfoIcon />
          </IconButton>
        </Toolbar>
      </AppBar>`;

  code = code.slice(0, idxStart) + newNavbar + code.slice(idxEnd);
} else {
  console.error("Could not find navbar boundaries!");
}

// 5. Workspace frame
code = code.replace(
  `      {/* Main Workspace split */}\n      <div className="reader-workspace-frame-nhentai">`,
  `      {/* Main Workspace split */}\n      <Box sx={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>`
);

// 6. Left Sidebar
code = code.replace(
  `        {showLeftSidebar && (\n          <div className="reader-left-sidebar-nhentai">`,
  `        {showLeftSidebar && (<Drawer variant="persistent" anchor="left" open={showLeftSidebar} sx={{ width: showLeftSidebar ? 320 : 0, flexShrink: 0, '& .MuiDrawer-paper': { width: 320, position: 'relative', boxSizing: 'border-box', borderRight: '1px solid var(--border-color)', bgcolor: 'background.paper' } }}><Box sx={{ height: '100%', overflowY: 'auto', p: 0 }}>`
);
// Close Left Sidebar
code = code.replace(
  `          </div>\n        )}\n\n        {/* Main Canvas Area */}`,
  `          </Box></Drawer>\n        )}\n\n        {/* Main Canvas Area */}`
);

// 7. Right Sidebar
code = code.replace(
  `        {showRightSidebar && (\n          <div className="reader-right-sidebar-nhentai">`,
  `        {showRightSidebar && (<Drawer variant="persistent" anchor="right" open={showRightSidebar} sx={{ width: showRightSidebar ? 320 : 0, flexShrink: 0, '& .MuiDrawer-paper': { width: 320, position: 'relative', boxSizing: 'border-box', borderLeft: '1px solid var(--border-color)', bgcolor: 'background.paper' } }}><Box sx={{ height: '100%', overflowY: 'auto', p: 0 }}>`
);
// Close Right Sidebar
code = code.replace(
  `          </div>\n        )}\n      </div>\n\n      {/* Confirm Modal */}`,
  `          </Box></Drawer>\n        )}\n      </Box>\n\n      {/* Confirm Modal */}`
);

// Outer Container Close
code = code.replace(
  `      <InfoModal\n        isOpen={infoModal.isOpen}`,
  `      </Box>\n      <InfoModal\n        isOpen={infoModal.isOpen}`
);


// 8. Toolbar floating controls (convert to Paper)
code = code.replaceAll(
  `              <div\n                className="reader-page-controls-nhentai"`,
  `              <Paper elevation={3} className="reader-page-controls-nhentai"`
);
// We also need to fix the closing tags of reader-page-controls-nhentai
// There is only one in Reader.tsx?
// Let's verify by string length or just ignore the closing tag (HTML doesn't strictly care about div vs Paper if we manually patch it?)
// Actually, MUI Paper is a Box, which compiles to <div>. But we must have matching JSX tags `<Paper> ... </Paper>`.
code = code.replace(
  `                  &gt;&gt;\n                </button>\n              </div>\n\n              {/* Chapter Navigation */}`,
  `                  &gt;&gt;\n                </button>\n              </Paper>\n\n              {/* Chapter Navigation */}`
);

fs.writeFileSync('frontend/src/components/Reader.tsx', code);
console.log("Migration complete!");
