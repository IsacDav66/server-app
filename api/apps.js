const express = require('express');
const { protect } = require('../middleware/auth');
const fetch = require('node-fetch'); // <-- ¡AÑADE LA IMPORTACIÓN AQUÍ!
// ==========================================================
// === ¡AÑADE ESTA LÍNEA AQUÍ! ===
// ==========================================================
const uploadStickerMiddleware = require('../middleware/uploadSticker');
// Recibimos 'fetch' como el tercer parámetro
module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // ==========================================================
    // === RUTAS ESPECÍFICAS (van primero para evitar conflictos) ===
    // ==========================================================

    // RUTA PARA OBTENER EL HISTORIAL COMPLETO DE APPS
    router.get('/history', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const userId = req.user.userId;
        try {
            const query = `
                SELECT
                    da.app_name,
                    da.package_name,
                    da.icon_url,
                    da.is_game
                FROM user_app_history AS upg
                LEFT JOIN detected_apps AS da ON upg.package_name = da.package_name
                WHERE upg.user_id = $1
                ORDER BY upg.last_seen_at DESC;
            `;
            const result = await pool.query(query, [userId]);
            console.log(`[API /apps/history] Encontradas ${result.rowCount} apps para el usuario ${userId}`);
            res.status(200).json({ success: true, apps: result.rows });
        } catch (error) {
            console.error("Error al obtener el historial de apps:", error);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });
    
    // RUTA PARA OBTENER APPS PENDIENTES DE CATEGORIZACIÓN
    router.get('/uncategorized', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const userId = req.user.userId;
        try {
            const query = `
                SELECT
                    da.app_name,
                    da.package_name,
                    da.icon_url
                FROM user_app_history upg
                JOIN detected_apps da ON upg.package_name = da.package_name
                WHERE upg.user_id = $1 AND da.is_game IS NULL
                ORDER BY upg.last_seen_at DESC;
            `;
            const result = await pool.query(query, [userId]);
            res.status(200).json({ success: true, apps: result.rows });
        } catch (error) {
            console.error("Error al obtener apps sin categorizar:", error);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    // RUTA PARA AÑADIR UNA NUEVA APP
    router.post('/add', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { packageName, appName } = req.body;
        const userId = req.user.userId;
        if (!packageName || !appName) {
            return res.status(400).json({ success: false, message: 'Faltan el nombre del paquete o el nombre de la app.' });
        }
        try {
            const query = `INSERT INTO detected_apps (package_name, app_name, added_by_user_id) VALUES ($1, $2, $3) RETURNING *;`;
            const result = await pool.query(query, [packageName, appName, userId]);
            res.status(201).json({ success: true, app: result.rows[0] });
        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({ success: false, message: 'Esta aplicación ya ha sido añadida.' });
            }
            console.error("Error al añadir app:", error);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    // RUTA PARA CLASIFICAR UNA APLICACIÓN
    router.post('/classify', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { packageName, is_game } = req.body;
        if (!packageName || typeof is_game !== 'boolean') {
            return res.status(400).json({ success: false, message: 'Faltan datos o el tipo de dato es incorrecto.' });
        }
        try {
            const updateQuery = 'UPDATE detected_apps SET is_game = $1 WHERE package_name = $2 RETURNING *';
            const result = await pool.query(updateQuery, [is_game, packageName]);
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, message: 'Aplicación no encontrada en la base de datos.' });
            }
            res.status(200).json({ success: true, message: 'Clasificación guardada.', app: result.rows[0] });
        } catch (error) {
            console.error("Error al clasificar la app:", error);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });
    
    // --- RUTAS DE GIPHY ---
    
    // Middleware para verificar la API Key. Se aplica a las rutas de stickers.
    router.use('/stickers', (req, res, next) => {
        if (!process.env.GIPHY_API_KEY) {
            console.error("❌ GIPHY ERROR: GIPHY_API_KEY no está definida.");
            return res.status(500).json({ success: false, message: "La integración con GIPHY no está configurada." });
        }
        next();
    });

     router.get('/stickers/search', async (req, res) => {
        const searchTerm = req.query.q;
        if (!searchTerm) return res.status(400).json({ success: false, message: 'Término de búsqueda requerido.' });
        
        const GIPHY_URL = `https://api.giphy.com/v1/stickers/search?api_key=${process.env.GIPHY_API_KEY}&q=${encodeURIComponent(searchTerm)}&limit=25&rating=g&lang=es`;
        try {
            // Esta llamada ahora funcionará porque 'fetch' está definido en este archivo.
            const giphyResponse = await fetch(GIPHY_URL);
            if (!giphyResponse.ok) throw new Error(`GIPHY API respondió con ${giphyResponse.status}`);
            const giphyData = await giphyResponse.json();
            res.json(giphyData);
        } catch (error) {
            console.error("Error en proxy a GIPHY (search):", error);
            res.status(502).json({ success: false, message: 'No se pudo comunicar con el servicio de stickers.' });
        }
    });

    router.get('/stickers/trending', async (req, res) => {
        // Usamos la URL correcta para STICKERS
        const GIPHY_URL = `https://api.giphy.com/v1/stickers/trending?api_key=${process.env.GIPHY_API_KEY}&limit=25&rating=g`;
        try {
            const giphyResponse = await fetch(GIPHY_URL);
            if (!giphyResponse.ok) throw new Error(`GIPHY API respondió con ${giphyResponse.status}`);
            const giphyData = await giphyResponse.json();
            res.json(giphyData);
        } catch (error) {
            console.error("Error en proxy a GIPHY (trending):", error);
            res.status(502).json({ success: false, message: 'No se pudo comunicar con el servicio de stickers.' });
        }
    });


    // ==========================================================
    // === RUTA GENÉRICA (DEBE IR AL FINAL) ===
    // ==========================================================
    
    // RUTA PARA OBTENER INFO DE UNA APP ESPECÍFICA por su nombre de paquete
    router.get('/:packageName', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { packageName } = req.params;
        try {
            const result = await pool.query('SELECT package_name, app_name, icon_url, is_game FROM detected_apps WHERE package_name = $1', [packageName]);
            if (result.rows.length > 0) {
                res.status(200).json({ success: true, found: true, app: result.rows[0] });
            } else {
                res.status(200).json({ success: true, found: false });
            }
        } catch (error) {
            res.status(500).json({ success: false, message: 'Error interno.' });
        }
    });

    // ==========================================================
    // === ¡NUEVA RUTA PARA SUBIR STICKERS PERSONALIZADOS! ===
    // ==========================================================
    router.post('/stickers/upload', 
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadStickerMiddleware,
        (req, res) => {
            if (!req.file) {
                return res.status(400).json({ success: false, message: 'No se recibió ningún archivo.' });
            }

            // Devolvemos la URL pública temporal del archivo subido
            const fileUrl = `/uploads/stickers_temp/${req.file.filename}`;
            res.status(200).json({ success: true, url: fileUrl });
        }
    );

    return router;
};