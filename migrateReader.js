const fs = require('fs');
let code = fs.readFileSync('frontend/src/components/Reader.tsx', 'utf8');

// Add imports
const importsToAdd = `
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import Paper from '@mui/material/Paper';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SettingsIcon from '@mui/icons-material/Settings';
import InfoIcon from '@mui/icons-material/Info';
`;

code = code.replace('import JSZip from "jszip";', 'import JSZip from "jszip";\n' + importsToAdd);

// Replace main container
code = code.replace('<div className="reader-container-nhentai">', '<Box sx={{ display: \'flex\', flexDirection: \'column\', height: \'100vh\', overflow: \'hidden\', bgcolor: \'background.default\' }}>');

// Replace top navbar
code = code.replace(
  /<div\s+className="reader-navbar-nhentai"[\s\S]*?<div style={{ display: "flex", alignItems: "center", gap: "12px" }}>/m,
  '<AppBar position="static" color="default" elevation={1} sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}><Toolbar variant="dense" sx={{ justifyContent: \'space-between\' }}><Box sx={{ display: \'flex\', alignItems: \'center\', gap: 1 }}>'
);

// Replace Navbar buttons
code = code.replace(
  /<button\s+className="reader-nav-btn back-btn"[\s\S]*?<\/svg>\s*<\/button>/m,
  `<IconButton onClick={() => navigate(\`/chapters/\${selectedChapter ? selectedChapter.id : ""}/\${selectedChapter ? toSlug(selectedChapter.title || \`chapter-\${selectedChapter.chapterNumber}\`) : ""}\`)} title="Back to Chapter" size="small" color="inherit"><ArrowBackIcon /></IconButton>`
);

code = code.replace(
  /<button\s+className={`reader-nav-btn gear-btn \${showLeftSidebar \? "active" : ""}`}[\s\S]*?<\/svg>\s*<\/button>/m,
  `<IconButton color={showLeftSidebar ? "primary" : "inherit"} onClick={() => setShowLeftSidebar((prev) => !prev)} title="Toggle Global Controls" size="small"><SettingsIcon /></IconButton>`
);

// Close Toolbar
code = code.replace(
  /<div\s+style={{\s*fontWeight: 600,\s*fontSize: "14px",\s*fontFamily: "var\(--font-display\)",[\s\S]*?}}>/m,
  '</Box><Typography variant="subtitle2" noWrap sx={{ maxWidth: \'50%\', fontWeight: 600, fontFamily: \'var(--font-display)\' }}>'
);
code = code.replace(
  /\{selectedChapter\?\.chapterNumber\}\s*<\/div>/m,
  '{selectedChapter?.chapterNumber}</Typography>'
);

code = code.replace(
  /<button\s+className={`reader-nav-btn gear-btn \${showRightSidebar \? "active" : ""}`}[\s\S]*?<\/svg>\s*<\/button>\s*<\/div>/m,
  `<IconButton color={showRightSidebar ? "primary" : "inherit"} onClick={() => setShowRightSidebar((prev) => !prev)} title="Toggle Property Inspector" size="small"><InfoIcon /></IconButton></Toolbar></AppBar>`
);

// Workspace Frame
code = code.replace('<div className="reader-workspace-frame-nhentai">', '<Box sx={{ display: \'flex\', flex: 1, minHeight: 0, overflow: \'hidden\' }}>');

// Left Sidebar
code = code.replace(
  /\{showLeftSidebar && \(\s*<div className="reader-left-sidebar-nhentai">/m,
  `{showLeftSidebar && (<Drawer variant="persistent" anchor="left" open={showLeftSidebar} sx={{ width: showLeftSidebar ? 320 : 0, flexShrink: 0, '& .MuiDrawer-paper': { width: 320, position: 'relative', boxSizing: 'border-box', borderRight: '1px solid var(--border-color)', bgcolor: 'background.paper' } }}><Box sx={{ height: '100%', overflowY: 'auto', p: 0 }}>`
);
// Right Sidebar
code = code.replace(
  /\{showRightSidebar && \(\s*<div className="reader-right-sidebar-nhentai">/m,
  `{showRightSidebar && (<Drawer variant="persistent" anchor="right" open={showRightSidebar} sx={{ width: showRightSidebar ? 320 : 0, flexShrink: 0, '& .MuiDrawer-paper': { width: 320, position: 'relative', boxSizing: 'border-box', borderLeft: '1px solid var(--border-color)', bgcolor: 'background.paper' } }}><Box sx={{ height: '100%', overflowY: 'auto', p: 0 }}>`
);

// Close Left Sidebar Drawer
code = code.replace(/<\/div>\s*\)\}\s*<div className="reader-canvas-area"/m, '</Box></Drawer>)}\n        <div className="reader-canvas-area"');
// Close Right Sidebar Drawer
code = code.replace(/<\/div>\s*\)\}\s*<\/div>\s*\{\/\* Confirm Modal \*\/\}/m, '</Box></Drawer>)}\n      </Box>\n      {/* Confirm Modal */}');
// Also close outer wrapper
code = code.replace(/<\/div>\s*<ConfirmModal/m, '</Box>\n      <ConfirmModal');


// Fix remaining floating toolbars to use Paper
code = code.replace(
  /<div\s+className="reader-page-controls-nhentai"/m,
  '<Paper elevation={3} className="reader-page-controls-nhentai"'
);
code = code.replace(
  /disabled=\{curPageNum >= totalPages\}\s*title="Last Page"\s*>\s*&gt;&gt;\s*<\/button>\s*<\/div>/m,
  'disabled={curPageNum >= totalPages}\n                  title="Last Page"\n                >\n                  &gt;&gt;\n                </button>\n              </Paper>'
);

fs.writeFileSync('frontend/src/components/Reader.tsx', code);
console.log('Replacements complete');
