// server/modules/botManager.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

const startAutonomousBot = async (pool, io) => {
    const runPostCycle = async () => {
        try {
            // 1. Obtenemos a los bots de la DB (incluida su llave)
            const botsResult = await pool.query(
                "SELECT id, username, bio, bot_personality, gemini_api_key FROM usersapp WHERE is_bot = TRUE"
            );
            
            for (const bot of botsResult.rows) {
                // 2. Si este bot no tiene llave configurada, lo saltamos
                if (!bot.gemini_api_key) {
                    console.log(`ℹ️ [${bot.username}] Saltado: No tiene Gemini API Key.`);
                    continue;
                }

                try {
                    // 3. Inicializamos Gemini con la llave específica de este bot
                    const genAI = new GoogleGenerativeAI(bot.gemini_api_key);
                    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", apiVersion: 'v1' });

                    const prompt = `Actúa como ${bot.username}. Personalidad: ${bot.bot_personality || bot.bio}. Escribe un post corto.`;

                    const result = await model.generateContent(prompt);
                    const content = result.response.text().trim();

                    if (content) {
                        // Guardar en DB y emitir Socket... (tu lógica habitual)
                        console.log(`🚀 [${bot.username}] Publicó usando su propia llave.`);
                    }
                } catch (error) {
                    console.error(`❌ Error en bot ${bot.username}:`, error.message);
                }
            }
        } catch (e) { console.error(e); }

        setTimeout(runPostCycle, (Math.random() * 20 + 20) * 60000);
    };
    runPostCycle();
};