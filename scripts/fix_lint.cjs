const fs = require('fs');

// Fix ReaderLeftSidebar.tsx
let left = fs.readFileSync('ReaderLeftSidebar.tsx', 'utf8');
left = left.replace(/\bBox,\s*/g, '');
left = left.replace(/import\s*\{\s*\}\s*from\s*"@mui\/material";\n/g, ''); // just in case
fs.writeFileSync('ReaderLeftSidebar.tsx', left);

// Fix ReaderRightSidebar.test.tsx
try {
  let testFile = fs.readFileSync('../__tests__/ReaderRightSidebar.test.tsx', 'utf8');
  testFile = testFile.replace(/\bfireEvent,\s*/g, '');
  testFile = testFile.replace(/\bwaitFor,\s*/g, '');
  fs.writeFileSync('../__tests__/ReaderRightSidebar.test.tsx', testFile);
} catch (e) {
  // might be in the same dir
  try {
    let testFile = fs.readFileSync('ReaderRightSidebar.test.tsx', 'utf8');
    testFile = testFile.replace(/\bfireEvent,\s*/g, '');
    testFile = testFile.replace(/\bwaitFor,\s*/g, '');
    fs.writeFileSync('ReaderRightSidebar.test.tsx', testFile);
  } catch(e) {}
}

