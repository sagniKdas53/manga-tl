const fs = require('fs');
let code = fs.readFileSync('frontend/src/components/Reader.tsx', 'utf8');

// 1. Navbar
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

code = code.replace(/<div\s+className="reader-navbar-nhentai"[\s\S]*?<\/svg>\s*<\/button>\s*<\/div>/, newNavbar);

fs.writeFileSync('frontend/src/components/Reader.tsx', code);
console.log("Navbar replaced");
