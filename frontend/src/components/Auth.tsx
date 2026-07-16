import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { User } from "../types";
import { safeFetch } from "../utils";

import Container from "@mui/material/Container";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import MenuItem from "@mui/material/MenuItem";
import CircularProgress from "@mui/material/CircularProgress";

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
  const [isLoading, setIsLoading] = useState(false);

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
    setIsLoading(true);
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
      setIsLoading(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Container maxWidth="xs">
        <Card elevation={3} sx={{ borderRadius: 4 }}>
          <CardContent sx={{ p: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Box textAlign="center">
              <Typography variant="h4" component="h2" gutterBottom sx={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>
                {isLogin ? "Welcome Back" : "Create Account"}
              </Typography>
              <Typography variant="body1" color="text.secondary">
                {isLogin
                  ? "Access your translation workspace"
                  : "Get started by creating a local user"}
              </Typography>
            </Box>

            <form onSubmit={handleAuthSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {!isLogin && (
                <>
                  <TextField
                    label="Display Name"
                    variant="outlined"
                    fullWidth
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="John Doe"
                    required
                  />
                  {isSetupRequired ? (
                    <Alert severity="warning">
                      <strong>Administrator</strong> (First user registration forces Admin privileges)
                    </Alert>
                  ) : (
                    <TextField
                      select
                      label="Account Role"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      fullWidth
                    >
                      <MenuItem value="translator">Translator</MenuItem>
                      <MenuItem value="viewer">Viewer</MenuItem>
                    </TextField>
                  )}
                </>
              )}
              
              <TextField
                label="Email Address"
                type="email"
                variant="outlined"
                fullWidth
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@manga.local"
                required
              />
              
              <TextField
                label="Password"
                type="password"
                variant="outlined"
                fullWidth
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />

              {authError && (
                <Alert severity="error">{authError}</Alert>
              )}

              <Button
                type="submit"
                variant="contained"
                color="primary"
                size="large"
                fullWidth
                disabled={isLoading}
                startIcon={isLoading ? <CircularProgress size={20} color="inherit" /> : undefined}
                sx={{ mt: 1 }}
              >
                {isLoading ? (isLogin ? "Signing In..." : "Signing Up...") : (isLogin ? "Sign In" : "Sign Up")}
              </Button>

              <Button
                type="button"
                color="primary"
                fullWidth
                onClick={() => {
                  setIsLogin(!isLogin);
                  setAuthError("");
                }}
              >
                {isLogin
                  ? "Don't have an account? Sign Up"
                  : "Already have an account? Sign In"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </Container>
    </Box>
  );
};

export default Auth;
