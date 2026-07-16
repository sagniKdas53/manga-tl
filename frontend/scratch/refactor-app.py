import re

with open('/home/sagnik/Projects/docker-composes/manga-library/frontend/src/App.tsx', 'r') as f:
    content = f.read()

# 1. Imports
mui_imports = """
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Avatar from "@mui/material/Avatar";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import SettingsIcon from "@mui/icons-material/Settings";
import LogoutIcon from "@mui/icons-material/Logout";
import PersonIcon from "@mui/icons-material/Person";
"""
content = content.replace('import { useColorScheme } from "@mui/material/styles";', 'import { useColorScheme } from "@mui/material/styles";\n' + mui_imports)

# 2. State variables
state_pattern = r'  const \[isLoadingDetails, setIsLoadingDetails\] = useState\(false\);'
state_replacement = """  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [anchorElUser, setAnchorElUser] = React.useState<null | HTMLElement>(null);"""
content = re.sub(state_pattern, state_replacement, content)

# 3. Nav JSX
nav_pattern = re.compile(r'          \{/\* Navigation Bar \*/\}.*?          \)}', re.DOTALL)
nav_replacement = """          {/* Navigation Bar */}
          {!readerMatch && (
            <AppBar position="sticky" color="default" elevation={1} sx={{ backgroundColor: 'background.paper', mb: 3 }}>
              <Toolbar>
                <Box
                  onClick={() => user && navigate("/")}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    cursor: user ? "pointer" : "default",
                    flexGrow: 1,
                  }}
                >
                  <img
                    src={theme === "dark" ? logoDark : logoLight}
                    alt="tl-hub logo"
                    style={{ height: "32px", width: "auto" }}
                  />
                  <Typography variant="h6" component="div" sx={{ fontWeight: 700 }}>
                    tl-hub
                  </Typography>
                </Box>
                
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <IconButton onClick={() => setMode(theme === "dark" ? "light" : "dark")} color="inherit" title={`Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`}>
                    {theme === "dark" ? <LightModeIcon /> : <DarkModeIcon />}
                  </IconButton>

                  {user && (
                    <>
                      <IconButton onClick={() => setIsSettingsOpen(true)} color="inherit" title="Settings">
                        <SettingsIcon />
                      </IconButton>
                      
                      <QueueManager token={user?.token} />
                      <NotificationCenter />
                      
                      <IconButton onClick={(e) => setAnchorElUser(e.currentTarget)} color="inherit">
                        <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main' }}>
                          {user.displayName.charAt(0).toUpperCase()}
                        </Avatar>
                      </IconButton>
                      <Menu
                        anchorEl={anchorElUser}
                        open={Boolean(anchorElUser)}
                        onClose={() => setAnchorElUser(null)}
                      >
                        <MenuItem disabled>
                          <Typography variant="body2">{user.displayName}</Typography>
                        </MenuItem>
                        <MenuItem onClick={() => { setAnchorElUser(null); handleLogout(); }}>
                          <LogoutIcon fontSize="small" sx={{ mr: 1 }} />
                          Sign Out
                        </MenuItem>
                      </Menu>
                    </>
                  )}
                </Box>
              </Toolbar>
            </AppBar>
          )}"""
content = nav_pattern.sub(nav_replacement, content)

with open('/home/sagnik/Projects/docker-composes/manga-library/frontend/src/App.tsx', 'w') as f:
    f.write(content)
