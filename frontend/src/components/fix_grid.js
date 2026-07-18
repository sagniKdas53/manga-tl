const fs = require('fs');

function fixFile(file) {
  let content = fs.readFileSync(file, 'utf8');

  // Replace <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
  content = content.replace(
    /<div\s*style=\{\{\s*display:\s*"grid",\s*gridTemplateColumns:\s*"1fr 1fr",\s*gap:\s*"8px",?\s*(marginBottom:\s*"4px",?)?\s*\}\}\s*>/g,
    (match, mb) => {
      return mb ? '<Grid container spacing={1} sx={{ mb: 0.5 }}>' : '<Grid container spacing={1}>';
    }
  );

  // The closing </div> for the grid is a bit tricky. We can just replace all </div> that close these.
  // Instead of complex regex, let's just do it manually in the AST or with a simple state machine?
  // Actually, we can just replace the child divs.
  content = content.replace(
    /<div\s*style=\{\{\s*display:\s*"flex",\s*flexDirection:\s*"column",\s*gap:\s*"4px",?\s*\}\}\s*>/g,
    '<Grid size={6} sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>'
  );

  // We also need to change the buttons in the Redo section.
  content = content.replace(
    /<Button\s*variant="outlined"\s*size="small"\s*style=\{\{\s*justifyContent:\s*"center",\s*gap:\s*"6px",\s*fontSize:\s*"12px",\s*padding:\s*"8px 6px",\s*height:\s*"36px",?\s*\}\}/g,
    '<Grid size={6} sx={{ display: "flex" }}>\n<Button variant="outlined" size="small" fullWidth sx={{ justifyContent: "center", gap: "6px", fontSize: "12px", padding: "8px 6px", height: "36px" }}'
  );
  
  // Wait, if I wrap the Button in Grid, the Button closing tag needs a </Grid>. 
  // Let's use a simpler approach: just find and replace manually.
}
