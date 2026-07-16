code = """import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Container from "@mui/material/Container";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import type { User } from "../types";
import { safeFetch } from "../utils";

interface AuthProps {
  onLoginSuccess: (user: User) => void;
}

export const Auth: React.FC<AuthProps> = ({ onLoginSuccess }) => {
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("translator");
  const [isSetupRequired, setIsSetupRequired] = useState(false);
  const [authError, setAuthError] = useState("");
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    if (!isLogin) {
      safeFetch("/api/auth/setup-required")
        .then((res) => {
          if (res.ok) return res.json();
          throw new Error("Failed to check setup");
        })
        .then((data) => {
          if (data.setupRequired) {
            setIsSetupRequired(true);
            setRole("admin");
          } else {
            setIsSetupRequired(false);
            setRole("translator");
          }
        })
        .catch((err) => {
          console.error("Error checking setup:", err);
          setIsSetupRequired(false);
          setRole("translator");
        });
    }
  }, [isLogin]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setLoading(true);
    const endpoint = isLogin ? "/api/auth/login" : "/api/auth/register";
    const payload = isLogin
      ? { email, password }
      : { email, password, displayName, role };

    try {
      const res = await safeFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Authentication failed");
      }

      const data: User = await res.json();
      localStorage.setItem("manga_user", JSON.stringify(data));
      onLoginSuccess(data);
      navigate("/");
      setEmail("");
      setPassword("");
      setDisplayName("");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setAuthError(message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container maxWidth="xs" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', py: 4 }}>
      <Card elevation={4} sx={{ width: '100%', borderRadius: 3 }}>
        <CardContent sx={{ p: 4 }}>
          <Box sx={{ mb: 4, textAlign: 'center' }}>
            <Typography variant="h4" component="h1" fontWeight="bold" gutterBottom>
              {isLogin ? "Welcome Back" : "Create Account"}
            </Typography>
            <Typography variant="body1" color="text.secondary">
              {isLogin
                ? "Access your translation workspace"
                : "Get started by creating a local user"}
            </Typography>
          </Box>
          
          <Box component="form" onSubmit={handleAuthSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {!isLogin && (
              <>
                <TextField
                  label="Display Name"
                  variant="outlined"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="John Doe"
                  fullWidth
                  required
                />
                
                {isSetupRequired ? (
                  <Alert severity="warning">
                    <strong>Administrator</strong> (First user registration forces Admin privileges)
                  </Alert>
                ) : (
                  <FormControl fullWidth>
                    <InputLabel id="role-label">Account Role</InputLabel>
                    <Select
                      labelId="role-label"
                      value={role}
                      label="Account Role"
                      onChange={(e) => setRole(e.target.value)}
                    >
                      <MenuItem value="translator">Translator</MenuItem>
                      <MenuItem value="viewer">Viewer</MenuItem>
                    </Select>
                  </FormControl>
                )}
              </>
            )}
            
            <TextField
              label="Email Address"
              type="email"
              variant="outlined"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@manga.local"
              fullWidth
              required
            />
            
            <TextField
              label="Password"
              type="password"
              variant="outlined"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              fullWidth
              required
            />

            {authError && (
              <Alert severity="error">
                {authError}
              </Alert>
            )}

            <Button
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              disabled={loading}
              sx={{ mt: 1 }}
            >
              {loading ? <CircularProgress size={24} color="inherit" /> : (isLogin ? "Sign In" : "Sign Up")}
            </Button>

            <Button
              variant="text"
              onClick={() => setIsLogin(!isLogin)}
              fullWidth
            >
              {isLogin
                ? "Don't have an account? Sign Up"
                : "Already have an account? Sign In"}
            </Button>
          </Box>
        </CardContent>
      </Card>
    </Container>
  );
};

export default Auth;
"""
with open("/home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/Auth.tsx", "w") as f:
    f.write(code)
