import re

with open("frontend/src/components/SettingsModal.tsx", "r") as f:
    content = f.read()

# Add Routing Strategy section
routing_section = """
            <Grid size={12}>
              <Typography
                variant="overline"
                color="text.disabled"
                sx={{
                  display: "block",
                  borderTop: 1,
                  borderColor: "divider",
                  pt: 1,
                }}
              >
                Advanced Routing
              </Typography>
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl fullWidth size="small">
                <InputLabel>OpenRouter Routing Strategy</InputLabel>
                <Select
                  value={settings.routingStrategy || "lowest-cost"}
                  label="OpenRouter Routing Strategy"
                  onChange={(e) => handleChange("routingStrategy", e.target.value)}
                >
                  <MenuItem value="lowest-cost">Lowest Cost (Default)</MenuItem>
                  <MenuItem value="highest-throughput">Highest Throughput</MenuItem>
                </Select>
              </FormControl>
            </Grid>
"""

idx = content.find("          </Grid>")
if idx != -1:
    content = content[:idx] + routing_section + content[idx:]

with open("frontend/src/components/SettingsModal.tsx", "w") as f:
    f.write(content)
