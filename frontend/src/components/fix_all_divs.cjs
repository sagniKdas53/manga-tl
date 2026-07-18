const fs = require('fs');

['ReaderRightSidebar.tsx', 'ReaderLeftSidebar.tsx'].forEach(file => {
  let content = fs.readFileSync(file, 'utf8');

  content = content.replace(/<div/g, '<Grid');
  content = content.replace(/<\/div>/g, '</Grid>');

  fs.writeFileSync(file, content);
});
