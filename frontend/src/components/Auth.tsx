import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Container from "@mui/material/Container";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { User } from "../types";
import { safeFetch } from "../utils";

interface AuthProps {
  onLoginSuccess: (user: User) => void;
}

const Auth: React.FC<AuthProps> = ({ onLoginSuccess }) => {
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("translator");
  const [isSetupRequired, setIsSetupRequired] = useState(false);
  const [authError, setAuthError] = useState("");

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
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        bgcolor: "background.default",
      }}
    >
      <Container maxWidth="xs">
        <Card elevation={0}>
          <CardContent sx={{ p: 4, "&:last-child": { pb: 4 } }}>
            <Typography
              variant="h5"
              component="h2"
              gutterBottom
              sx={{ fontFamily: '"Outfit", sans-serif', fontWeight: 700 }}
            >
              {isLogin ? "Welcome Back" : "Create Account"}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {isLogin
                ? "Access your translation workspace"
                : "Get started by creating a local user"}
            </Typography>
            <Box component="form" onSubmit={handleAuthSubmit}>
              {!isLogin && (
                <>
                  <TextField
                    label="Display Name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="John Doe"
                    required
                    fullWidth
                    margin="normal"
                  />
                  {isSetupRequired ? (
                    <Alert severity="warning" sx={{ mt: 1, mb: 1 }}>
                      <strong>Administrator</strong> (First user registration
                      forces Admin privileges)
                    </Alert>
                  ) : (
                    <FormControl fullWidth margin="normal">
                      <InputLabel>Account Role</InputLabel>
                      <Select
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
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@manga.local"
                required
                fullWidth
                margin="normal"
              />
              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                fullWidth
                margin="normal"
              />
              {authError && (
                <Alert severity="error" sx={{ mt: 2 }}>
                  {authError}
                </Alert>
              )}
              <Stack spacing={2} sx={{ mt: 3 }}>
                <Button type="submit" variant="contained" fullWidth>
                  {isLogin ? "Sign In" : "Sign Up"}
                </Button>
                <Button
                  type="button"
                  onClick={() => setIsLogin(!isLogin)}
                  fullWidth
                >
                  {isLogin
                    ? "Don't have an account? Sign Up"
                    : "Already have an account? Sign In"}
                </Button>
              </Stack>
            </Box>
          </CardContent>
        </Card>
      </Container>
    </Box>
  );
};

export default Auth;