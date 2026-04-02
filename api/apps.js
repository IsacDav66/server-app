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
const sharp = require('sharp'); // 👈 Importamos Sharp para las imágenes
const processImage = require('../middleware/processImage'); // Importar el middleware

// Función para generar la huella digital (MD5)
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

            // --- FUNCIÓN CENTRAL DE PROCESAMIENTO ---
            // Se encarga de Hashear, verificar duplicados y registrar en BD
            const processFinalFile = async (relativeUrl, mimeType) => {
                try {
                    const fullPath = path.join(__dirname, '../', relativeUrl);
                    const fileHash = await getHash(fullPath);

                    const existing = await pool.query('SELECT file_path FROM media_library WHERE hash = $1', [fileHash]);

                    if (existing.rows.length > 0) {
                        console.log("♻️ Duplicado optimizado detectado. Usando existente.");
                        fs.unlink(fullPath, () => {}); 
                        return res.status(200).json({ success: true, url: existing.rows[0].file_path });
                    }

                    await pool.query('INSERT INTO media_library (hash, file_path, mime_type) VALUES ($1, $2, $3)', 
                        [fileHash, relativeUrl, mimeType]);
                    
                    return res.status(200).json({ success: true, url: relativeUrl });
                } catch (err) {
                    console.error("Error en deduplicación:", err);
                    return res.status(200).json({ success: true, url: relativeUrl });
                }
            };

            // --- CAMINO A: VIDEOS -> CONVERTIR A WEBM ---
            if (inputFile.mimetype.startsWith('video/')) {
                const startTime = parseFloat(req.body.startTime) || 0;
                const muteAudio = req.body.muteAudio === 'true';

                const outputFilename = `sticker-${Date.now()}.webm`; // 👈 Extensión WebM
                const outputPath = path.join(__dirname, '../uploads/stickers_temp/', outputFilename);

                const command = ffmpeg(inputFile.path)
                    .setFfmpegPath('/usr/bin/ffmpeg')
                    .outputOptions([
                        `-ss ${startTime}`,
                        '-t 10',
                        '-vf scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:(ow-iw)/2:(oh-ih)/2:color=black@0', // Cuadrado con fondo transparente si es posible
                        '-c:v libvpx', // 👈 Codec WebM (VP8 es más rápido para stickers)
                        '-crf 30',     // Calidad constante (20-40 es bueno)
                        '-b:v 1M',     // Bitrate máximo
                        '-auto-alt-ref 0', 
                        '-f webm'
                    ]);
                
                if (!muteAudio) command.outputOptions('-c:a libvorbis'); // Audio para WebM
                else command.outputOptions('-an');

                command
                    .on('end', async () => {
                        fs.unlink(inputFile.path, () => {}); // Borrar original
                        const fileUrl = `/uploads/stickers_temp/${outputFilename}`;
                        await processFinalFile(fileUrl, 'video/webm'); 
                    })
                    .on('error', (err) => {
                        console.error('Error de FFmpeg:', err.message);
                        fs.unlink(inputFile.path, () => {});
                        res.status(500).json({ success: false, message: 'Error al procesar el vídeo.' });
                    })
                    .save(outputPath);

            } 
            // --- CAMINO B: IMÁGENES/GIFS -> CONVERTIR A WEBP ---
            else {
                const outputFilename = `sticker-${Date.now()}.webp`; // 👈 Todo a WebP
                const outputPath = path.join(__dirname, '../uploads/stickers_temp/', outputFilename);

                try {
                    // Usamos Sharp para redimensionar y convertir
                    // { animated: true } permite que los GIFs sigan siendo animados en WebP
                    await sharp(inputFile.path, { animated: true })
                        .resize(256, 256, { fit: 'cover' })
                        .webp({ quality: 75 }) // Compresión equilibrada
                        .toFile(outputPath);

                    fs.unlink(inputFile.path, () => {}); // Borrar el original subido por Multer
                    
                    const fileUrl = `/uploads/stickers_temp/${outputFilename}`;
                    await processFinalFile(fileUrl, 'image/webp');

                } catch (err) {
                    console.error("Error de Sharp:", err);
                    fs.unlink(inputFile.path, () => {});
                    res.status(500).json({ success: false, message: 'Error al procesar la imagen.' });
                }
            }
        }
    );


// server/api/apps.js
const axios = require('axios');
const qs = require('querystring');



// --- 🚀 NUEVA RUTA: Obtener éxitos mundiales (Motor iTunes) ---
router.get('/music/trending', async (req, res) => {
    try {
        console.log(`🔍 Cargando tendencias desde iTunes API...`);
        
        // Buscamos "Top Hits" para simular una lista de tendencias
        const response = await axios.get(`https://itunes.apple.com/search?term=hits&limit=25&media=music`, {
            timeout: 10000
        });

        const results = response.data.results.map(v => ({
            id: v.trackId,
            title: v.trackName,
            author: v.artistName,
            thumb: v.artworkUrl100.replace('100x100bb', '400x400bb'), // Portada en alta resolución
            preview_url: v.previewUrl, // Link de audio MP3 (30 seg)
            duration: "0:30"
        }));

        res.json({ success: true, results });
    } catch (error) {
        console.error("❌ ERROR ITUNES TRENDING:", error.message);
        res.status(502).json({ success: false });
    }
});

// --- 🚀 NUEVA RUTA: Buscador de música (Motor iTunes) ---
router.get('/music/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ success: false });

    console.log(`🔍 Buscando en iTunes: ${query}`);

    try {
        const response = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&limit=25&media=music`, {
            timeout: 10000
        });

        const results = response.data.results.map(v => ({
            id: v.trackId,
            title: v.trackName,
            author: v.artistName,
            thumb: v.artworkUrl100.replace('100x100bb', '400x400bb'),
            preview_url: v.previewUrl,
            duration: "0:30"
        }));

        res.json({ success: true, results });
    } catch (error) {
        console.error("❌ ERROR ITUNES SEARCH:", error.message);
        res.status(500).json({ success: false });
    }
});

// --- RUTA REFRESH (Para compatibilidad con tu chat) ---
router.get('/music/refresh/:trackId', async (req, res) => {
    try {
        const { trackId } = req.params;
        const response = await axios.get(`https://itunes.apple.com/lookup?id=${trackId}`);
        
        if (response.data.results && response.data.results[0]) {
            res.json({ success: true, preview_url: response.data.results[0].previewUrl });
        } else {
            res.status(404).json({ success: false });
        }
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// server/api/apps.js

// --- RUTA: Subida de Emojis (Soporta Imagen, GIF y Video) ---
router.post('/emojis/upload', protect, uploadStickerMiddleware, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No se recibió el archivo' });
    }

    const tempInputPath = req.file.path; // Archivo subido por Multer
    const targetDir = path.join(__dirname, '../uploads/emojis/');
    
    // Asegurar que la carpeta destino existe
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    // 🚀 DETECCIÓN DE TIPO DE ARCHIVO
    const originalName = req.file.originalname.toLowerCase();
    const isLottie = originalName.endsWith('.json') || originalName.endsWith('.lottie'); // 🚀 Detectar ambos
    const isVideo = req.file.mimetype.startsWith('video/');

    // Nombre de archivo final
    const extension = isLottie ? path.extname(originalName) : '.webp';
    const finalFilename = `emoji-${Date.now()}${extension}`;
    const finalPath = path.join(targetDir, finalFilename);

    try {
        // --- 1. PROCESAMIENTO SEGÚN TIPO ---

        if (isLottie) {
            // A. CASO LOTTIE: Copiamos el archivo JSON tal cual, sin procesar
            fs.copyFileSync(tempInputPath, finalPath);
            console.log('✅ Archivo Lottie (.json) guardado correctamente');
        } 
        else if (isVideo) {
            // B. CASO VIDEO: Usar FFmpeg para convertir a WebP animado de 3 segundos
            const startTime = parseFloat(req.body.startTime) || 0;

            await new Promise((resolve, reject) => {
                ffmpeg(tempInputPath)
                    .setFfmpegPath('/usr/bin/ffmpeg') // Ajusta la ruta según tu servidor
                    .outputOptions([
                        `-ss ${startTime}`, // Tiempo de inicio del trimmer
                        '-t 3',             // Límite de 3 segundos para emojis
                        // Ajuste de escala y recorte para que sea un cuadrado perfecto de 128x128
                        '-vf scale=128:128:force_original_aspect_ratio=increase,crop=128:128',
                        '-vcodec libwebp',  // Convertir a WebP
                        '-lossless 0',      // Compresión con pérdida para ligereza
                        '-compression_level 4',
                        '-q:v 70',          // Calidad del WebP
                        '-loop 0',          // Bucle infinito
                        '-an'               // Forzar sin audio (obligatorio para emojis)
                    ])
                    .on('end', resolve)
                    .on('error', (err) => {
                        console.error('❌ Error FFmpeg:', err);
                        reject(err);
                    })
                    .save(finalPath);
            });
            console.log('✅ Video convertido a Emoji WebP animado');
        } 
        else {
            // C. CASO IMAGEN / GIF: Usar Sharp para convertir a WebP de 128px
            await sharp(tempInputPath, { animated: true })
                .resize(128, 128, { 
                    fit: 'cover', 
                    position: 'center' 
                }) 
                .webp({ quality: 75 })
                .toFile(finalPath);
            console.log('✅ Imagen/GIF convertida a Emoji WebP');
        }

        // --- 2. DEDUPLICACIÓN (SISTEMA DE HASH) ---
        // Calculamos el hash del archivo que acabamos de generar/copiar
        const fileHash = await getHash(finalPath);
        const existingMedia = await pool.query('SELECT file_path FROM media_library WHERE hash = $1', [fileHash]);

        if (existingMedia.rows.length > 0) {
            console.log("♻️ Emoji duplicado detectado por Hash. Usando existente.");
            
            // Borramos el archivo que acabamos de crear y el temporal de Multer
            if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); 
            if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath); 

            const existingFilePath = existingMedia.rows[0].file_path;
            return res.status(200).json({ 
                success: true, 
                url: existingFilePath, 
                filename: path.basename(existingFilePath) 
            });
        }

        // --- 3. REGISTRO EN BASE DE DATOS ---
        const relativeUrl = `/uploads/emojis/${finalFilename}`;
        const finalMime = isLottie ? (originalName.endsWith('.json') ? 'application/json' : 'application/octet-stream') : 'image/webp';

        
        await pool.query('INSERT INTO media_library (hash, file_path, mime_type) VALUES ($1, $2, $3)', 
            [fileHash, relativeUrl, finalMime]);

        // --- 4. LIMPIEZA FINAL ---
        // Borrar el archivo original subido (MP4, PNG, JSON original, etc.)
        if (fs.existsSync(tempInputPath)) {
            fs.unlink(tempInputPath, (err) => {
                if (err) console.error("Error al borrar temporal original:", err);
            });
        }

        console.log(`✨ Emoji final guardado: ${finalFilename}`);

        res.status(200).json({ 
            success: true, 
            url: relativeUrl, 
            filename: finalFilename 
        });

    } catch (err) {
        console.error("❌ Error crítico en emojis/upload:", err);
        
        // Limpieza de emergencia en caso de error
        if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
        if (fs.existsSync(finalPath)) {
            try { fs.unlinkSync(finalPath); } catch(e) {}
        }
        
        res.status(500).json({ success: false, message: 'Error interno al procesar el emoji.' });
    }
});



const AdmZip = require('adm-zip'); // 🚀 Asegúrate de que esta línea esté arriba con los demás require

// --- NUEVA RUTA: Subida masiva vía ZIP (Para Android y Packs de Telegram) ---
router.post('/emojis/upload-pack', protect, uploadStickerMiddleware, async (req, res) => {
    if (!req.file || !req.file.path.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ success: false, message: 'Se requiere un archivo .zip' });
    }

    const tempZipPath = req.file.path;
    const targetDir = path.join(__dirname, '../uploads/emojis/');
    const packName = req.file.originalname.replace(/\.[^/.]+$/, ""); // Nombre del archivo sin .zip
    
    try {
        const zip = new AdmZip(tempZipPath);
        const zipEntries = zip.getEntries();
        const emojiGroups = {};

        // 1. Agrupar archivos del ZIP por carpetas (Cada subcarpeta es un emoji)
        zipEntries.forEach(entry => {
            if (entry.isDirectory) return;
            
            const pathParts = entry.entryName.split('/');
            // Telegram export: PackName/Subfolder(001)/archivo.ext
            if (pathParts.length >= 2) {
                const subfolder = pathParts[pathParts.length - 2];
                if (!emojiGroups[subfolder]) emojiGroups[subfolder] = [];
                emojiGroups[subfolder].push(entry);
            }
        });

        // 2. Definir Prioridad
        const priority = { 
            '.lottie': 1, 
            '.json': 2, 
            '.webm': 3, 
            '.mp4': 4, 
            '.webp': 5, 
            '.png': 6, 
            '.jpg': 7, 
            '.jpeg': 7 
        };

        const winners = [];
        for (const folder in emojiGroups) {
            let bestEntry = null;
            let bestRank = 999;

            emojiGroups[folder].forEach(entry => {
                const ext = path.extname(entry.name).toLowerCase();
                const rank = priority[ext] || 1000;
                if (rank < bestRank) {
                    bestRank = rank;
                    bestEntry = entry;
                }
            });
            if (bestEntry) winners.push(bestEntry);
        }

        // 3. Procesar y Guardar los ganadores
        const finalUploadedFilenames = [];

        for (const entry of winners) {
            const ext = path.extname(entry.name).toLowerCase();
            const isLottieOrJson = ext === '.lottie' || ext === '.json';
            
            // Nombre único para evitar colisiones
            const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
            const finalFilename = `emoji-${uniqueId}${isLottieOrJson ? ext : '.webp'}`;
            const finalPath = path.join(targetDir, finalFilename);

            const buffer = entry.getData();

            if (isLottieOrJson) {
                // Guardar JSON/Lottie directo
                fs.writeFileSync(finalPath, buffer);
            } else {
                // Si es imagen o video, lo pasamos por Sharp para estandarizar a WebP 128px
                // Nota: Para simplificar la subida masiva, procesamos solo imágenes aquí. 
                // Los videos en un ZIP se guardarán tal cual o podrías añadir FFmpeg aquí.
                try {
                    await sharp(buffer)
                        .resize(128, 128, { fit: 'cover' })
                        .webp({ quality: 75 })
                        .toFile(finalPath);
                } catch (e) {
                    // Si falla Sharp (ej. es un video), lo guardamos directo como fallback
                    fs.writeFileSync(finalPath, buffer);
                }
            }

            // --- 4. DEDUPLICACIÓN Y REGISTRO EN BD ---
            const fileHash = await getHash(finalPath);
            const existingMedia = await pool.query('SELECT file_path FROM media_library WHERE hash = $1', [fileHash]);

            if (existingMedia.rows.length > 0) {
                // Si ya existe por Hash, borramos el que acabamos de extraer y usamos el viejo
                fs.unlinkSync(finalPath);
                finalUploadedFilenames.push(path.basename(existingMedia.rows[0].file_path));
            } else {
                const relativeUrl = `/uploads/emojis/${finalFilename}`;
                const mimeType = isLottieOrJson ? (ext === '.json' ? 'application/json' : 'application/octet-stream') : 'image/webp';
                
                await pool.query('INSERT INTO media_library (hash, file_path, mime_type) VALUES ($1, $2, $3)', 
                    [fileHash, relativeUrl, mimeType]);
                
                finalUploadedFilenames.push(finalFilename);
            }
        }

        // 5. Limpieza del ZIP temporal
        fs.unlinkSync(tempZipPath);

        console.log(`📦 Pack ZIP "${packName}" procesado. ${finalUploadedFilenames.length} emojis importados.`);

        res.status(200).json({ 
            success: true, 
            filenames: finalUploadedFilenames, 
            packName: packName 
        });

    } catch (err) {
        console.error("❌ Error procesando pack ZIP:", err);
        if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
        res.status(500).json({ success: false, message: 'Error al procesar el archivo comprimido.' });
    }
});


// --- NUEVA RUTA: Subida masiva de Stickers vía ZIP ---
router.post('/stickers/upload-pack', protect, uploadStickerMiddleware, async (req, res) => {
    if (!req.file || !req.file.path.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ success: false, message: 'Se requiere un archivo .zip' });
    }

    const tempZipPath = req.file.path;
    const targetDir = path.join(__dirname, '../uploads/stickers_temp/');
    const packName = req.file.originalname.replace(/\.[^/.]+$/, "");
    
    try {
        const zip = new AdmZip(tempZipPath);
        const zipEntries = zip.getEntries();
        const stickerGroups = {};

        // 1. Agrupar archivos del ZIP por carpetas
        zipEntries.forEach(entry => {
            if (entry.isDirectory) return;
            const pathParts = entry.entryName.split('/');
            if (pathParts.length >= 2) {
                const subfolder = pathParts[pathParts.length - 2];
                if (!stickerGroups[subfolder]) stickerGroups[subfolder] = [];
                stickerGroups[subfolder].push(entry);
            }
        });

        // 2. Prioridad de Stickers: WebM (Video) > WebP (Animado/Estatico) > Otros
        const priority = { '.webm': 1, '.webp': 2, '.gif': 3, '.png': 4, '.jpg': 5, '.jpeg': 5, '.mp4': 6 };

        const winners = [];
        for (const folder in stickerGroups) {
            let bestEntry = null;
            let bestRank = 999;
            stickerGroups[folder].forEach(entry => {
                const ext = path.extname(entry.name).toLowerCase();
                const rank = priority[ext] || 1000;
                if (rank < bestRank) { bestRank = rank; bestEntry = entry; }
            });
            if (bestEntry) winners.push(bestEntry);
        }

        // 3. Procesar y Guardar
        const finalUploadedUrls = [];

        for (const entry of winners) {
            const ext = path.extname(entry.name).toLowerCase();
            const isVideo = ext === '.webm' || ext === '.mp4';
            const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
            const finalFilename = `sticker-${uniqueId}${isVideo ? ext : '.webp'}`;
            const finalPath = path.join(targetDir, finalFilename);

            const buffer = entry.getData();

            if (isVideo) {
                fs.writeFileSync(finalPath, buffer);
            } else {
                try {
                    // Stickers a 512px (Calidad superior a emojis)
                    await sharp(buffer, { animated: true })
                        .resize(512, 512, { fit: 'cover' })
                        .webp({ quality: 75 })
                        .toFile(finalPath);
                } catch (e) {
                    fs.writeFileSync(finalPath, buffer);
                }
            }

            // 4. Registro y Deduplicación por Hash
            const fileHash = await getHash(finalPath);
            const existingMedia = await pool.query('SELECT file_path FROM media_library WHERE hash = $1', [fileHash]);

            if (existingMedia.rows.length > 0) {
                fs.unlinkSync(finalPath);
                finalUploadedUrls.push(existingMedia.rows[0].file_path);
            } else {
                const relativeUrl = `/uploads/stickers_temp/${finalFilename}`;
                const mimeType = isVideo ? `video/${ext.slice(1)}` : 'image/webp';
                await pool.query('INSERT INTO media_library (hash, file_path, mime_type) VALUES ($1, $2, $3)', 
                    [fileHash, relativeUrl, mimeType]);
                finalUploadedUrls.push(relativeUrl);
            }
        }

        fs.unlinkSync(tempZipPath);
        res.status(200).json({ success: true, urls: finalUploadedUrls, packName });

    } catch (err) {
        console.error("❌ Error procesando ZIP de stickers:", err);
        if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
        res.status(500).json({ success: false, message: 'Error al procesar el pack.' });
    }
});


    return router;
};