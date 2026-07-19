const fs = require('fs');
let content = fs.readFileSync('frontend/src/components/Reader.tsx', 'utf8');
// Replace literal '\n' with actual newlines
content = content.replace(/\\n/g, '\n');
fs.writeFileSync('frontend/src/components/Reader.tsx', content);
console.log("Fixed newlines in Reader.tsx");
