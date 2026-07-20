const fs = require('fs');
const { Client } = require('pg');
const path = require('path');

async function migrate() {
    const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/manga_library';
    const client = new Client({ connectionString: dbUrl });
    
    try {
        await client.connect();
        console.log('Connected to PostgreSQL.');

        // Ensure tables exist (if hibernate hasn't created them yet)
        await client.query(`
            CREATE TABLE IF NOT EXISTS job_costs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                job_id VARCHAR(255),
                image_id UUID NOT NULL,
                provider VARCHAR(255),
                model VARCHAR(255),
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                estimated_cost DOUBLE PRECISION,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS model_rates (
                model_id VARCHAR(255) PRIMARY KEY,
                provider VARCHAR(255),
                prompt_price DOUBLE PRECISION,
                completion_price DOUBLE PRECISION,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Tables verified/created.');

        const costsPath = path.join(__dirname, '../data/worker/rendered_cache/costs.json');
        if (fs.existsSync(costsPath)) {
            const data = JSON.parse(fs.readFileSync(costsPath, 'utf8'));
            for (const [modelId, rates] of Object.entries(data)) {
                let provider = 'openrouter';
                if (modelId.includes('/')) {
                    provider = modelId.split('/')[0];
                } else if (modelId.startsWith('gemini')) {
                    provider = 'gemini';
                }
                
                await client.query(`
                    INSERT INTO model_rates (model_id, provider, prompt_price, completion_price, updated_at)
                    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                    ON CONFLICT (model_id) DO UPDATE SET 
                        prompt_price = EXCLUDED.prompt_price,
                        completion_price = EXCLUDED.completion_price,
                        updated_at = CURRENT_TIMESTAMP;
                `, [modelId, provider, rates.prompt, rates.completion]);
                console.log(`Migrated rates for model: ${modelId}`);
            }
            console.log('Successfully migrated costs.json to model_rates.');
        } else {
            console.log('No costs.json found to migrate.');
        }

    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await client.end();
    }
}

migrate();
