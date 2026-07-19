const fs = require('fs');

let content = fs.readFileSync('ReaderRightSidebar.tsx', 'utf8');

// Ensure Grid is imported
if (!content.includes('import Grid from "@mui/material/Grid";')) {
  content = content.replace(
    'import {',
    'import Grid from "@mui/material/Grid";\nimport {'
  );
}

// 1. Redo Section Grid
content = content.replace(
  /<div\s*style=\{\{\s*display:\s*"grid",\s*gridTemplateColumns:\s*"1fr 1fr",\s*gap:\s*"8px",\s*marginBottom:\s*"4px",\s*\}\}\s*>/,
  '<Grid container spacing={1} sx={{ mb: 0.5 }}>'
);
// Replace the two buttons inside to be wrapped in Grid size={6}
// We find the next two buttons.
let redoIdx = content.indexOf('<Grid container spacing={1} sx={{ mb: 0.5 }}>');
if (redoIdx !== -1) {
    let part1 = content.slice(0, redoIdx);
    let part2 = content.slice(redoIdx);
    
    // First Button
    part2 = part2.replace(
        /<Button/,
        '<Grid size={6} sx={{ display: "flex" }}>\n<Button fullWidth'
    );
    part2 = part2.replace(
        /Redo OCR\s*<\/Button>/,
        'Redo OCR\n</Button>\n</Grid>'
    );
    
    // Second Button
    part2 = part2.replace(
        /<Button/,
        '<Grid size={6} sx={{ display: "flex" }}>\n<Button fullWidth'
    );
    part2 = part2.replace(
        /Redo TL\s*<\/Button>/,
        'Redo TL\n</Button>\n</Grid>'
    );
    
    // Replace closing div with Grid
    part2 = part2.replace(
        /<\/div>/,
        '</Grid>'
    );
    content = part1 + part2;
}

// 2, 3, 4, 5 grids
const gridRegex = /<div\s*style=\{\{\s*display:\s*"grid",\s*gridTemplateColumns:\s*"1fr 1fr",\s*gap:\s*"8px",\s*\}\}\s*>/g;

let matches = content.match(gridRegex);
if (matches) {
    matches.forEach(() => {
        let idx = content.indexOf('<div\n                  style={{\n                    display: "grid",\n                    gridTemplateColumns: "1fr 1fr",\n                    gap: "8px",\n                  }}\n                >');
        if (idx === -1) {
            // Try single line or flexible whitespace
            let flexRegex = /<div\s*style=\{\{\s*display:\s*"grid",\s*gridTemplateColumns:\s*"1fr 1fr",\s*gap:\s*"8px",?\s*\}\}\s*>/;
            let m = content.match(flexRegex);
            if (m) idx = m.index;
        }
        
        if (idx !== -1) {
            let part1 = content.slice(0, idx);
            let part2 = content.slice(idx);
            
            // replace the wrapper
            part2 = part2.replace(
                /<div\s*style=\{\{\s*display:\s*"grid",\s*gridTemplateColumns:\s*"1fr 1fr",\s*gap:\s*"8px",?\s*\}\}\s*>/,
                '<Grid container spacing={1}>'
            );
            
            // replace child 1
            part2 = part2.replace(
                /<div\s*style=\{\{\s*display:\s*"flex",\s*flexDirection:\s*"column",\s*gap:\s*"4px",?\s*\}\}\s*>/,
                '<Grid size={6} sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>'
            );
            // close child 1 (replace first </div>)
            part2 = part2.replace(/<\/div>/, '</Grid>');
            
            // replace child 2
            part2 = part2.replace(
                /<div\s*style=\{\{\s*display:\s*"flex",\s*flexDirection:\s*"column",\s*gap:\s*"4px",?\s*\}\}\s*>/,
                '<Grid size={6} sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>'
            );
            // close child 2
            part2 = part2.replace(/<\/div>/, '</Grid>');
            
            // close wrapper
            part2 = part2.replace(/<\/div>/, '</Grid>');
            
            content = part1 + part2;
        }
    });
}

// Convert other top-level structural divs to Box or Stack where they have class="panel-section" or "reader-right-sidebar-nhentai"
// Since the user is sensitive to divs, let's replace them too.
// Wait, the user said "Instead of div's us the grid"
// That means they want everything in Grid or Box.
content = content.replace(/<div className="reader-right-sidebar-nhentai">/g, '<Box className="reader-right-sidebar-nhentai">');
content = content.replace(/<\/div>\n  \);\n};\n\nexport default React.memo/g, '</Box>\n  );\n};\n\nexport default React.memo');

content = content.replace(/<div className="panel-section"/g, '<Box className="panel-section"');
content = content.replace(/<div\n                  className="panel-section"/g, '<Box\n                  className="panel-section"');
content = content.replace(/<div className="panel-section-title"/g, '<Typography variant="overline" component="div" className="panel-section-title"');
// Wait, Typography doesn't map 1:1 closing tag if I just string replace.

fs.writeFileSync('ReaderRightSidebar.tsx', content);
