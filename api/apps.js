const express = require('express');
const { protect } = require('../middleware/auth');
const fetch = require('node-fetch'); // <-- ¡AÑADE LA IMPORTACIÓN AQUÍ!
// ==========================================================
// === ¡AÑADE ESTA LÍNEA AQUÍ! ===
// ==========================================================
const uploadStickerMiddleware = require('../middleware/uploadSticker');
const fs = require('fs'); // <-- ¡AÑADE ESTA IMPORTACIÓN!
const path = require('path'); // <-- ¡AÑADE ESTA IMPORTACIÓN!
const ffmpeg = require('fluent-ffmpeg'); // <-- ¡AÑADE ESTA IMPORTACIÓN!
const crypto = require('crypto');

function getHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', err => reject(err));
    });
}
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

    // --- RUTA DE SUBIDA DE STICKERS (ACTUALIZADA PARA RECORTAR VÍDEO) ---
    router.post('/stickers/upload', 
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadStickerMiddleware,
        async (req, res) => {
            if (!req.file) {
                return res.status(400).json({ success: false, message: 'No se recibió ningún archivo.' });
            }
            
            const inputFile = req.file;

            // --- FUNCIÓN INTERNA PARA EVITAR DUPLICADOS ---
            const processFinalFile = async (relativeUrl, mimeType) => {
                try {
                    const fullPath = path.join(__dirname, '../', relativeUrl);
                    const fileHash = await getHash(fullPath);

                    // 1. Buscar si el hash ya existe en la DB
                    const existing = await pool.query('SELECT file_path FROM media_library WHERE hash = $1', [fileHash]);

                    if (existing.rows.length > 0) {
                        console.log("♻️ WhatsApp Style: Duplicado detectado. Borrando archivo nuevo y usando existente.");
                        fs.unlink(fullPath, () => {}); // Borramos el que acabamos de crear
                        return res.status(200).json({ success: true, url: existing.rows[0].file_path });
                    }

                    // 2. Si es nuevo, registrar en la librería
                    await pool.query('INSERT INTO media_library (hash, file_path, mime_type) VALUES ($1, $2, $3)', 
                        [fileHash, relativeUrl, mimeType]);
                    
                    return res.status(200).json({ success: true, url: relativeUrl });
                } catch (err) {
                    console.error("Error en deduplicación:", err);
                    return res.status(200).json({ success: true, url: relativeUrl }); // Fallback: enviamos el archivo aunque falle el registro
                }
            };

            if (inputFile.mimetype.startsWith('video/')) {
                const startTime = parseFloat(req.body.startTime) || 0;
                const muteAudio = req.body.muteAudio === 'true';

                const outputFilename = `sticker-${Date.now()}.mp4`;
                const outputPath = path.join(__dirname, '../uploads/stickers_temp/', outputFilename);

                const command = ffmpeg(inputFile.path)
                    .setFfmpegPath('/usr/bin/ffmpeg')
                    .outputOptions([
                        `-ss ${startTime}`,
                        '-t 10',
                        '-vf scale=256:-2',
                        '-c:v libx264',
                        '-preset ultrafast',
                        '-movflags +faststart'
                    ]);
                
                if (!muteAudio) command.outputOptions('-c:a aac');
                else command.outputOptions('-an');

                command
                    .on('end', async () => {
                        // Borramos el vídeo ORIGINAL pesado que subió el usuario
                        fs.unlink(inputFile.path, () => {}); 
                        
                        // Procesamos el sticker RECORTADO
                        const fileUrl = `/uploads/stickers_temp/${outputFilename}`;
                        await processFinalFile(fileUrl, 'video/mp4'); 
                    })
                    .on('error', (err) => {
                        console.error('Error de FFmpeg:', err.message);
                        fs.unlink(inputFile.path, () => {});
                        res.status(500).json({ success: false, message: 'Error al procesar el vídeo.' });
                    })
                    .save(outputPath);

            } else {
                // Caso: Imagen o GIF (Subida directa)
                const fileUrl = `/uploads/stickers_temp/${inputFile.filename}`;
                await processFinalFile(fileUrl, inputFile.mimetype);
            }
        }
    );


// server/api/apps.js
const axios = require('axios');
const qs = require('querystring');



// --- NUEVA RUTA: Obtener éxitos mundiales (Trending) ---
router.get('/music/trending', async (req, res) => {
    try {
        console.log(`🔍 Cargando música tendencia desde Deezer...`);
        // El ID 0 en la playlist suele ser el Top Global
        const response = await axios.get(`https://api.deezer.com/chart/0/tracks&limit=20`);

        const results = response.data.data.map(v => ({
            id: v.id,
            title: v.title,
            author: v.artist.name,
            thumb: v.album.cover_medium,
            preview_url: v.preview,
            duration: "0:30"
        }));

        res.json({ success: true, results });
    } catch (error) {
        console.error("❌ ERROR TRENDING:", error.message);
        res.status(500).json({ success: false });
    }
});

// --- NUEVA RUTA: Obtener link fresco de una canción específica ---
router.get('/music/refresh/:trackId', async (req, res) => {
    try {
        const { trackId } = req.params;
        const response = await axios.get(`https://api.deezer.com/track/${trackId}`);
        
        if (response.data && response.data.preview) {
            res.json({ success: true, preview_url: response.data.preview });
        } else {
            res.status(404).json({ success: false });
        }
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

router.get('/music/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ success: false });

    console.log(`🔍 Buscando en Deezer: ${query}`);

    try {
        // Deezer no necesita Token, es una API pública muy rápida
        const response = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=20`);

        // Mapeamos los resultados al formato que ya usas
        const results = response.data.data.map(v => ({
            id: v.id,
            title: v.title,
            author: v.artist.name,
            thumb: v.album.cover_medium, // Imagen de buena calidad
            preview_url: v.preview,       // EL LINK MP3 (Deezer siempre tiene)
            duration: "0:30"
        }));

        console.log(`✅ Deezer envió ${results.length} resultados.`);
        res.json({ success: true, results });

    } catch (error) {
        console.error("❌ ERROR DEEZER:", error.message);
        res.status(500).json({ success: false });
    }
});

// server/api/apps.js

// --- NUEVA RUTA: Subida específica de Emojis ---
router.post('/emojis/upload', protect, uploadStickerMiddleware, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No se recibió el archivo' });
    }

    // 1. Definir y crear carpeta de destino si no existe
    const targetDir = path.join(__dirname, '../uploads/emojis/');
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    // 2. Definir nombres y rutas
    const newFilename = `emoji-${Date.now()}${path.extname(req.file.originalname)}`;
    const newPath = path.join(targetDir, newFilename);

    try {
        // 3. Mover el archivo desde la carpeta temporal de stickers a la de emojis
        // Usamos renameSync para moverlo físicamente en el disco
        fs.renameSync(req.file.path, newPath);

        console.log(`✅ Emoji guardado: ${newFilename}`);

        res.status(200).json({ 
            success: true, 
            url: `/uploads/emojis/${newFilename}`, 
            filename: newFilename 
        });
    } catch (err) {
        console.error("❌ Error al mover el emoji:", err);
        // Intentar limpiar el archivo temporal si el movimiento falló
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        
        res.status(500).json({ success: false, message: 'Error interno al procesar el archivo' });
    }
});




    return router;
};