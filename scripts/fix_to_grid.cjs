const fs = require('fs');

['ReaderRightSidebar.tsx', 'ReaderLeftSidebar.tsx'].forEach(file => {
  let content = fs.readFileSync(file, 'utf8');

  // Replace imports: make sure Grid is imported, remove Box if unused after (or just leave it)
  if (!content.includes('import Grid from "@mui/material/Grid";')) {
    content = content.replace('import {', 'import Grid from "@mui/material/Grid";\nimport {');
  }

  // Replace <Box ...> with <Grid ...>
  // Be careful not to replace Box imports
  content = content.replace(/<Box/g, '<Grid');
  content = content.replace(/<\/Box>/g, '</Grid>');

  fs.writeFileSync(file, content);
});
