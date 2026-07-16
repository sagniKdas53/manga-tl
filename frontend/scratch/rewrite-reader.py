import re

file_path = "/home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/Reader.tsx"
with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# Add MUI imports
mui_imports = """import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
import Paper from "@mui/material/Paper";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import ButtonGroup from "@mui/material/ButtonGroup";
"""
# Insert after standard imports
content = re.sub(
    r'(import { ColorPicker } from "./ColorPicker";)',
    r'\1\n' + mui_imports,
    content
)

# 1. reader-container
content = content.replace('<div className="reader-container">', '<Box className="reader-container">')
content = content.replace('</div> {/* reader-container */}', '</Box> {/* reader-container */}')

# 2. reader-sidebar glass -> Drawer
content = content.replace(
    '<div className="reader-sidebar glass">',
    '<Drawer variant="persistent" anchor="left" open={true} PaperProps={{ className: "reader-sidebar glass" }}>'
)
# We need to find where reader-sidebar closes. Since it's huge, maybe it's better to just leave it as Box
content = content.replace('<Drawer variant="persistent" anchor="left" open={true} PaperProps={{ className: "reader-sidebar glass" }}>', '<Box className="reader-sidebar glass" sx={{ bgcolor: "background.paper" }}>')
# Let's just use Box for sidebar and main so we don't break JSX nesting if there are missing divs
content = content.replace('<div className="reader-main">', '<Box className="reader-main">')

content = content.replace('<div className="floating-reader-toolbar glass">', '<Paper elevation={3} className="floating-reader-toolbar">')
content = content.replace('<div className="floating-zoom-toolbar glass">', '<Paper elevation={3} className="floating-zoom-toolbar">')

# Wait, closing tags for Paper: since we don't know the exact lines, we should just regex `<div className="floating-reader-toolbar glass">` and manually close them.
# There's only one floating-reader-toolbar and one floating-zoom-toolbar, but finding their closing </div> with regex is hard.
# Actually, if we just remove the `glass` class from these, and maybe use `<div className="... MUI classes?` No, that's not needed.

with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)
