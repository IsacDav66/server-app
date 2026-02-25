// Archivo: /server/api/user.js (VERSIÓN COMPLETA Y CORREGIDA)

const express = require('express');
const sanitizeHtml = require('sanitize-html'); // <-- 1. IMPORTAR SANITIZER
const { protect, softProtect, adminOnly } = require('../middleware/auth'); 
// Crea un grupo de protección

const uploadMiddleware = require('../middleware/upload');
const uploadCoverMiddleware = require('../middleware/uploadCover');
const uploadBioImageMiddleware = require('../middleware/uploadBioImage'); // <-- 2. IMPORTAR NUEVO MIDDLEWARE
const processImage = require('../middleware/processImage');
const uploadPlayerCardCoverMiddleware = require('../middleware/uploadPlayerCardCover');

const path = require('path');
// EN LA PARTE SUPERIOR DEL ARCHIVO, JUNTO A LOS OTROS REQUIRES
const admin = require('firebase-admin'); // <-- SOLO NECESITAS IMPORTARLO

module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // RUTA PROTEGIDA: Obtener datos del usuario LOGUEADO
    router.get('/me', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        try {
            // ¡LA CLAVE!: Añadimos 'role' a la lista
            const query = 'SELECT id, email, username, age, gender, profile_pic_url, bio, cover_pic_url, role FROM usersapp WHERE id = $1';
            const result = await pool.query(query, [req.user.userId]);
            
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
            
            const user = result.rows[0];
            const isProfileComplete = !!user.username;
            
            res.status(200).json({ success: true, data: { userId: user.id, ...user, isProfileComplete } });
        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error al obtener los datos.' });
        }
    });
    // RUTA PÚBLICA: Obtener datos de perfil de CUALQUIER usuario
    // REEMPLAZA tu ruta /profile/:userId con esta
    // RUTA PÚBLICA: Obtener datos de perfil de CUALQUIER usuario (VERSIÓN MEJORADA)
     // RUTA PÚBLICA: Obtener datos de perfil de CUALQUIER usuario (VERSIÓN FINAL)
    router.get('/profile/:userId', (req, res, next) => softProtect(req, res, next, JWT_SECRET), async (req, res) => {
        const userId = parseInt(req.params.userId, 10);
        const loggedInUserId = req.user ? req.user.userId : null;

        if (isNaN(userId)) return res.status(400).json({ success: false, message: 'El ID de usuario no es válido.' });

        try {
            // ==========================================================
            // === ¡CONSULTA MEJORADA CON LATERAL JOIN! ===
            // ==========================================================
            const query = `
                SELECT 
                    u.id, u.username, u.profile_pic_url, u.bio, u.cover_pic_url, u.bio_bg_url, u.age, u.gender,
                    (SELECT COUNT(*) FROM postapp WHERE user_id = u.id) AS post_count,
                    (SELECT COUNT(*) FROM followersapp WHERE following_id = u.id) AS followers_count,
                    (SELECT COUNT(*) FROM followersapp WHERE follower_id = u.id) AS following_count,
                    EXISTS(SELECT 1 FROM followersapp WHERE follower_id = $2 AND following_id = $1) AS is_followed_by_user,
                    
                    -- Obtenemos el nombre, icono y fecha del último juego en una sola subconsulta eficiente
                    lp.app_name AS last_played_game,
                    lp.last_played_at,
                    lp.icon_url AS last_played_game_icon_url

                FROM usersapp u
                LEFT JOIN LATERAL (
                    SELECT
                        da.app_name,
                        da.icon_url,
                        upg.last_played_at
                    FROM user_played_games upg
                    JOIN detected_apps da ON upg.package_name = da.package_name
                    WHERE upg.user_id = u.id
                    ORDER BY upg.last_played_at DESC
                    LIMIT 1
                ) lp ON true
                WHERE u.id = $1;
            `;
            // ==========================================================
            
            const result = await pool.query(query, [userId, loggedInUserId]);
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Perfil no encontrado.' });
            
            res.status(200).json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error interno al obtener el perfil.' });
        }
    });


   // ----------------------------------------------------
// RUTA: Actualizar/Completar Perfil (CON SANITIZACIÓN MEJORADA)
// ----------------------------------------------------
router.post('/complete-profile', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const { username, age, gender, bio } = req.body;
    const userId = req.user.userId;

    // --- CONFIGURACIÓN DE SANITIZACIÓN PARA QUILL.JS ---
    const cleanBio = bio ? sanitizeHtml(bio, {
        // 1. Permitir las etiquetas que usa Quill
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'span', 'p', 'h1', 'h2', 'h3']),
        
        // 2. Permitir los atributos 'class' y 'style'
        allowedAttributes: {
            ...sanitizeHtml.defaults.allowedAttributes,
            'span': ['style', 'class'], // Permitir style y class en span
            'p': ['class'],            // Permitir class en p
            'img': ['src', 'width', 'height', 'style']
        },

        // 3. (CLAVE) Permitir CLASES específicas de Quill para tamaño y alineación
        allowedClasses: {
            'p': ['ql-align-center', 'ql-align-right', 'ql-align-justify'],
            'span': ['ql-size-small', 'ql-size-large', 'ql-size-huge']
        },

        // 4. (CLAVE) Permitir ESTILOS específicos para color y resaltado
        allowedStyles: {
            'span': {
              'color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/],
              'background-color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/]
            }
        }
    }) : null;

    try {
        const query = `
            UPDATE usersapp SET 
                username = COALESCE($1, username), 
                age = COALESCE($2, age), 
                gender = COALESCE($3, gender), 
                bio = COALESCE($4, bio)
            WHERE id = $5;
        `;
        await pool.query(query, [
            username || null, 
            age || null, 
            gender || null, 
            cleanBio,
            userId
        ]);
        
        res.status(200).json({ success: true, message: 'Perfil actualizado con éxito.' });

    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ success: false, message: 'El nombre de usuario ya está en uso.' });
        }
        console.error("Error al actualizar perfil:", error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});


    // --- 5. NUEVA RUTA: Para imágenes incrustadas en la biografía ---
    router.post('/upload-bio-image',
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadBioImageMiddleware,
        processImage('bio'),
        (req, res) => {
            if (!req.file) return res.status(400).json({ success: false, message: 'No se subió archivo.' });
            const publicPath = `/uploads/bio_images/${req.file.filename}`;
            res.status(200).json({ success: true, url: publicPath });
        }
    );


    // --- 6. NUEVA RUTA: Para la imagen de FONDO de la biografía ---
    router.post('/upload-bio-bg',
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadBioImageMiddleware, // Reutilizamos el mismo middleware de subida
        processImage('bio'),      // y de procesamiento
        async (req, res) => {
            if (!req.file) return res.status(400).json({ success: false, message: 'No se subió archivo.' });
            const publicPath = `/uploads/bio_images/${req.file.filename}`;
            try {
                await pool.query('UPDATE usersapp SET bio_bg_url = $1 WHERE id = $2', [publicPath, req.user.userId]);
                res.status(200).json({ success: true, url: publicPath });
            } catch (error) {
                console.error(error);
                res.status(500).json({ success: false, message: 'Error al guardar la URL de fondo.' });
            }
        }
    );

    // ----------------------------------------------------
    // RUTA: Subir Foto de Perfil
    // ----------------------------------------------------
    router.post('/upload-profile-pic', 
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadMiddleware,
        processImage('profile'),
        async (req, res) => {
            if (!req.file) return res.status(400).json({ success: false, message: 'No se subió ningún archivo.' });
            
            const publicPath = `/uploads/profile_images/${req.file.filename}`;
            try {
                await pool.query('UPDATE usersapp SET profile_pic_url = $1 WHERE id = $2', [publicPath, req.user.userId]);
                res.status(200).json({ success: true, message: 'Foto de perfil actualizada.', profilePicUrl: publicPath });
            } catch (error) {
                console.error(error.stack);
                res.status(500).json({ success: false, message: 'Error al guardar la URL del perfil.' });
            }
        });


      // ----------------------------------------------------
    // NUEVA RUTA: Subir Foto de Portada
    // ----------------------------------------------------
    router.post('/upload-cover-pic', 
        (req, res, next) => protect(req, res, next, JWT_SECRET), // 1. Proteger ruta
        uploadCoverMiddleware,                                   // 2. Multer sube a memoria
        processImage('cover'),                                   // 3. Sharp procesa y guarda como .webp
        async (req, res) => {
            if (!req.file) {
                return res.status(400).json({ success: false, message: 'No se subió ningún archivo.' });
            }
            
            // 4. Construir la URL pública y guardar en la BD
            const publicPath = `/uploads/cover_images/${req.file.filename}`;
            try {
                await pool.query('UPDATE usersapp SET cover_pic_url = $1 WHERE id = $2', [publicPath, req.user.userId]);
                res.status(200).json({ 
                    success: true, 
                    message: 'Foto de portada actualizada.', 
                    coverPicUrl: publicPath 
                });
            } catch (error) {
                console.error(error.stack);
                res.status(500).json({ success: false, message: 'Error al guardar la URL de la portada.' });
            }
        });


    // RUTA PARA REGISTRAR O ACTUALIZAR EL TOKEN FCM
router.post('/fcm-token', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const { token } = req.body;
    const userId = req.user.userId;

    if (!token) {
        return res.status(400).json({ success: false, message: 'No se proporcionó ningún token.' });
    }

    try {
        const query = 'UPDATE usersapp SET fcm_token = $1 WHERE id = $2';
        await pool.query(query, [token, userId]);
        res.status(200).json({ success: true, message: 'Token FCM actualizado.' });
    } catch (error) {
        console.error('Error al guardar el token FCM:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});
    // ----------------------------------------------------
    // NUEVA RUTA: Seguir / Dejar de seguir a un usuario
    // ----------------------------------------------------
    // --- RUTA DE SEGUIMIENTO CON PAYLOAD DE NOTIFICACIÓN UNIFICADO ---
    router.post('/follow/:userId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const followerId = req.user.userId;
        const followingId = parseInt(req.params.userId, 10);

        if (isNaN(followingId) || followerId === followingId) {
            return res.status(400).json({ success: false, message: 'Solicitud inválida.' });
        }

        try {
            // Lógica de "Dejar de Seguir" (sin cambios)
            const deleteResult = await pool.query('DELETE FROM followersapp WHERE follower_id = $1 AND following_id = $2', [followerId, followingId]);
            if (deleteResult.rowCount > 0) {
                return res.status(200).json({ success: true, action: 'unfollowed' });
            }

            // Lógica de "Seguir" (sin cambios)
            await pool.query('INSERT INTO followersapp (follower_id, following_id) VALUES ($1, $2)', [followerId, followingId]);
            
            const senderData = (await pool.query('SELECT username, profile_pic_url FROM usersapp WHERE id = $1', [followerId])).rows[0];

            // 4. Lógica de Notificación DENTRO DE LA APP (Socket.IO)
            try {
                const notifQuery = `INSERT INTO notificationsapp (recipient_id, sender_id, type) VALUES ($1, $2, 'new_follower') RETURNING *;`;
                const notifResult = await pool.query(notifQuery, [followingId, followerId]);
                
                const notificationPayload = {
                    ...notifResult.rows[0],
                    sender_username: senderData.username,
                    sender_profile_pic_url: senderData.profile_pic_url
                };

                const io = req.app.get('socketio');
                const userRoom = `user-${followingId}`;
                io.to(userRoom).emit('new_notification', notificationPayload);
                console.log(`Notificación en-app enviada a la sala ${userRoom}`);
            } catch (inAppNotifError) {
                console.error("Error al procesar la notificación en la app (Socket.IO):", inAppNotifError);
            }

            // 5. Lógica de NOTIFICACIÓN PUSH (Firebase Cloud Messaging) con imagen
            // --- LÓGICA DE NOTIFICACIÓN PUSH (CON ESTRUCTURA CORREGIDA) ---
            try {
                const tokenResult = await pool.query('SELECT fcm_token FROM usersapp WHERE id = $1', [followingId]);
                const userToNotify = tokenResult.rows[0];

                if (userToNotify && userToNotify.fcm_token) {
                    
                    // ==========================================================
                    // === ¡AQUÍ ESTÁ LA CORRECCIÓN ESTRUCTURAL! ===
                    // ==========================================================
                    // Construimos un payload de "SOLO DATOS", sin el campo "notification".
                    const message = {
                        token: userToNotify.fcm_token,
                        data: {
                            // Datos para que el cliente construya la notificación
                            title: '¡Nuevo Seguidor!',
                            body: `${senderData.username} ha comenzado a seguirte.`,
                            
                            // Los campos que faltaban y que nuestro servicio Java requiere
                            channelId: 'followers_channel', // El ID del canal para seguidores
                            groupId: `followers-${followingId}`, // Un ID de grupo para todas las notificaciones de seguidor de este usuario

                            // Datos adicionales para la acción de clic y el icono
                            senderId: String(followerId),
                            openUrl: `user_profile.html?id=${followerId}`
                        },
                        android: {
                            priority: 'high'
                        }
                    };
                    // ==========================================================

                    // Añadir la URL de la imagen directamente al campo `data`
                    if (senderData.profile_pic_url) {
                        const fullImageUrl = (process.env.PUBLIC_SERVER_URL + senderData.profile_pic_url).trim();
                        message.data.imageUrl = fullImageUrl;
                    }
                    
                    await admin.messaging().send(message);
                    console.log(`Notificación de DATOS de seguidor enviada al usuario ${followingId}`);
                }
            } catch (pushError) {
                console.error("❌ PUSH: Error al enviar la notificación push de seguidor:", pushError);
            }
            
            return res.status(201).json({ success: true, action: 'followed' });

        } catch (error) {
            console.error('❌ Error crítico en la ruta /follow:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    // ====================================================
    // === NUEVA RUTA: BÚSQUEDA DE USUARIOS             ===
    // ====================================================
    router.get('/search', async (req, res) => {
        // Obtenemos el término de búsqueda de la query string (ej: ?q=Isac)
        const searchTerm = req.query.q;

        // Si no hay término de búsqueda, devolvemos un array vacío.
        if (!searchTerm || searchTerm.trim() === '') {
            return res.status(200).json({ success: true, users: [] });
        }

        try {
            // Preparamos el término de búsqueda para una consulta LIKE, insensible a mayúsculas/minúsculas.
            // Los '%' son comodines que significan "cualquier cosa".
            const searchQuery = `%${searchTerm}%`;

            // Consulta SQL segura usando parámetros ($1) para prevenir inyección SQL.
            const query = `
                SELECT id, username, profile_pic_url 
                FROM usersapp 
                WHERE username ILIKE $1 
                LIMIT 10;
            `;
            
            const result = await pool.query(query, [searchQuery]);

            res.status(200).json({ success: true, users: result.rows });

        } catch (error) {
            console.error('❌ Error en la búsqueda de usuarios:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor al buscar usuarios.' });
        }
    });



  // =============================================================
// === NUEVAS RUTAS: OBTENER LISTAS DE SEGUIDORES / SEGUIDOS ===
// =============================================================

// Ruta para obtener la lista de SEGUIDORES de un usuario
router.get('/:userId/followers', (req, res, next) => softProtect(req, res, next, JWT_SECRET), async (req, res) => {
    const targetUserId = parseInt(req.params.userId);
    const loggedInUserId = req.user ? req.user.userId : null;

    if (isNaN(targetUserId)) return res.status(400).json({ success: false, message: 'ID de usuario inválido.' });

    try {
        const query = `
            SELECT 
                u.id, 
                u.username, 
                u.profile_pic_url,
                -- Comprueba si el usuario logueado sigue a esta persona de la lista
                EXISTS(SELECT 1 FROM followersapp WHERE follower_id = $2 AND following_id = u.id) AS is_followed_by_user
            FROM usersapp u
            JOIN followersapp f ON u.id = f.follower_id
            WHERE f.following_id = $1;
        `;
        const result = await pool.query(query, [targetUserId, loggedInUserId]);
        res.status(200).json({ success: true, users: result.rows });
    } catch (error) {
        console.error('Error al obtener seguidores:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});

// Ruta para obtener la lista de personas que un usuario SIGUE (following)
router.get('/:userId/following', (req, res, next) => softProtect(req, res, next, JWT_SECRET), async (req, res) => {
    const targetUserId = parseInt(req.params.userId);
    const loggedInUserId = req.user ? req.user.userId : null;

    if (isNaN(targetUserId)) return res.status(400).json({ success: false, message: 'ID de usuario inválido.' });
    
    try {
        const query = `
            SELECT 
                u.id, 
                u.username, 
                u.profile_pic_url,
                -- Comprueba si el usuario logueado sigue a esta persona de la lista
                EXISTS(SELECT 1 FROM followersapp WHERE follower_id = $2 AND following_id = u.id) AS is_followed_by_user
            FROM usersapp u
            JOIN followersapp f ON u.id = f.following_id
            WHERE f.follower_id = $1;
        `;
        const result = await pool.query(query, [targetUserId, loggedInUserId]);
        res.status(200).json({ success: true, users: result.rows });
    } catch (error) {
        console.error('Error al obtener seguidos:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});



// ==========================================================
    // === ¡NUEVA RUTA PARA OBTENER LA LISTA DE AMIGOS MUTUOS! ===
    // ==========================================================
    router.get('/friends', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;

        try {
            // Esta consulta utiliza un INNER JOIN con la misma tabla para encontrar seguimientos recíprocos.
            const query = `
                SELECT
                    u.id,
                    u.username,
                    u.profile_pic_url
                FROM followersapp f1
                INNER JOIN followersapp f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id
                JOIN usersapp u ON f1.following_id = u.id
                WHERE f1.follower_id = $1;
            `;
            
            const result = await pool.query(query, [loggedInUserId]);
            
            // Ahora, enriquecemos el resultado con el estado en línea
            const onlineUsers = req.app.get('onlineUsers'); // Obtenemos el mapa de usuarios en línea
            const friendsWithStatus = result.rows.map(friend => ({
                ...friend,
                is_online: Array.from(onlineUsers.values()).includes(friend.id)
            }));

            res.status(200).json({ success: true, friends: friendsWithStatus });
        } catch (error) {
            console.error('Error al obtener la lista de amigos:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

// RUTA PARA OBTENER SOLO LOS JUEGOS JUGADOS (CON LOGS DE DEPURACIÓN)
// RUTA PARA OBTENER SOLO LOS JUEGOS JUGADOS (CON CORRECCIÓN DE SINTAXIS)
router.get('/:userId/played-games', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const targetUserId = parseInt(req.params.userId);

    if (isNaN(targetUserId)) {
        return res.status(400).json({ success: false, message: 'ID de usuario inválido.' });
    }

    try {
        const query = `
            SELECT
                da.app_name,
                da.package_name,
                da.icon_url
            FROM user_played_games upg
            JOIN detected_apps da ON upg.package_name = da.package_name
            WHERE upg.user_id = $1
            ORDER BY upg.last_played_at DESC;
        `;
        
        console.log(`[API /played-games] Buscando juegos para userId: ${targetUserId}`);
        const result = await pool.query(query, [targetUserId]);
        console.log(`[API /played-games] Filas encontradas en la BD: ${result.rowCount}`);
        
        res.status(200).json({ success: true, games: result.rows });
    } catch (error) { // <-- ¡LLAVES AÑADIDAS AQUÍ!
        console.error("Error al obtener los juegos jugados del usuario:", error);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    } // <-- ¡LLAVES AÑADIDAS AQUÍ!
});
// ==========================================================


// ==========================================================
    // === ¡NUEVA RUTA PARA CREAR/ACTUALIZAR UNA TARJETA DE JUGADOR! ===
    // ==========================================================
    // RUTA PARA CREAR/ACTUALIZAR UNA TARJETA DE JUGADOR (VERSIÓN CORREGIDA)
    router.post('/player-cards',
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadPlayerCardCoverMiddleware,
        processImage('card_cover'),
        async (req, res) => {
            const userId = req.user.userId;
            const { packageName, inGameUsername, inGameId, inviteLink } = req.body;

            // ==========================================================
            // === ¡AQUÍ ESTÁ LA LÓGICA CORREGIDA! ===
            // ==========================================================
            // 1. Por defecto, usamos la URL de la imagen existente que nos envía el frontend.
            let coverImageUrl = req.body.existingCoverUrl || null;

            // 2. Si se subió un archivo NUEVO, sobrescribimos la URL con la nueva ruta.
            if (req.file) {
                coverImageUrl = `/uploads/card_cover_images/${req.file.filename}`;
            }
            // ==========================================================

            if (!packageName) {
                return res.status(400).json({ success: false, message: 'Falta el nombre del paquete del juego.' });
            }

            try {
                // La consulta UPSERT no necesita cambios, ya que usa la variable `coverImageUrl`
                const query = `
                    INSERT INTO player_cards (user_id, package_name, in_game_username, in_game_id, invite_link, cover_image_url, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                    ON CONFLICT (user_id, package_name)
                    DO UPDATE SET
                        in_game_username = EXCLUDED.in_game_username,
                        in_game_id = EXCLUDED.in_game_id,
                        invite_link = EXCLUDED.invite_link,
                        cover_image_url = EXCLUDED.cover_image_url,
                        updated_at = CURRENT_TIMESTAMP
                    RETURNING *;
                `;
                const result = await pool.query(query, [userId, packageName, inGameUsername, inGameId, inviteLink, coverImageUrl]);
                res.status(200).json({ success: true, message: 'Tarjeta de jugador guardada.', card: result.rows[0] });
            } catch (error) {
                console.error("Error al guardar la tarjeta de jugador:", error);
                res.status(500).json({ success: false, message: 'Error interno del servidor.' });
            }
        }
    );

    // ==========================================================
    // === ¡NUEVA RUTA PARA OBTENER LAS TARJETAS DE UN USUARIO! ===
    // ==========================================================
    // RUTA PARA OBTENER LAS TARJETAS DE UN USUARIO (VERSIÓN FINAL Y CORREGIDA)
    router.get('/:userId/player-cards', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const targetUserId = parseInt(req.params.userId);
        if (isNaN(targetUserId)) return res.status(400).json({ success: false, message: 'ID de usuario inválido.' });

        try {
            // ==========================================================
            // === ¡CONSULTA CORREGIDA! ===
            // ==========================================================
            // Especificamos cada columna para evitar ambigüedades.
            // Aseguramos que 'card_id' se seleccione explícitamente.
            const query = `
                SELECT 
                    pc.card_id, 
                    pc.user_id, 
                    pc.package_name, 
                    pc.in_game_username, 
                    pc.in_game_id, 
                    pc.invite_link, 
                    pc.cover_image_url,
                    da.app_name,
                    da.icon_url
                FROM player_cards pc
                JOIN detected_apps da ON pc.package_name = da.package_name
                WHERE pc.user_id = $1
                ORDER BY pc.display_order ASC;
            `;
            // ==========================================================

            const result = await pool.query(query, [targetUserId]);
            res.status(200).json({ success: true, cards: result.rows });
        } catch (error) {
            console.error("Error al obtener las tarjetas de jugador:", error);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    // ==========================================================
    // === ¡NUEVA RUTA PARA GUARDAR EL ORDEN DE LAS TARJETAS! ===
    // ==========================================================
    router.post('/player-cards/reorder', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const userId = req.user.userId;
        const { orderedCardIds } = req.body;

        if (!Array.isArray(orderedCardIds)) {
            return res.status(400).json({ success: false, message: 'Se esperaba un array de IDs.' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const updatePromises = orderedCardIds.map((cardIdStr, index) => {
                // ==========================================================
                // === ¡AQUÍ ESTÁ LA VALIDACIÓN DE SEGURIDAD! ===
                // ==========================================================
                const cardId = parseInt(cardIdStr);

                // Si cardId no es un número válido, simplemente saltamos esta iteración.
                if (isNaN(cardId)) {
                    console.warn(`[REORDER WARN] Se recibió un cardId inválido: '${cardIdStr}'. Se ignora.`);
                    return Promise.resolve(); // Devuelve una promesa resuelta para no romper Promise.all
                }
                // ==========================================================
                
                const query = `
                    UPDATE player_cards 
                    SET display_order = $1 
                    WHERE card_id = $2 AND user_id = $3;
                `;
                return client.query(query, [index, cardId, userId]);
            });

            await Promise.all(updatePromises);

            await client.query('COMMIT');
            res.status(200).json({ success: true, message: 'Orden guardado.' });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error("Error al reordenar las tarjetas:", error);
            res.status(500).json({ success: false, message: 'Error interno al guardar el orden.' });
        } finally {
            client.release();
        }
    });

// ==========================================================
    // === ¡NUEVA RUTA PARA ELIMINAR UNA TARJETA DE JUGADOR! ===
    // ==========================================================
    router.delete('/player-cards/:cardId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const userId = req.user.userId;
        const cardId = parseInt(req.params.cardId);

        if (isNaN(cardId)) {
            return res.status(400).json({ success: false, message: 'ID de tarjeta inválido.' });
        }

        try {
            // La consulta DELETE solo tendrá éxito si el card_id coincide Y el user_id
            // de la tarjeta coincide con el ID del usuario que hace la solicitud.
            const deleteQuery = `
                DELETE FROM player_cards 
                WHERE card_id = $1 AND user_id = $2;
            `;
            const result = await pool.query(deleteQuery, [cardId, userId]);

            // Si no se eliminó ninguna fila, significa que la tarjeta no existe o no pertenece al usuario.
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, message: 'No se encontró la tarjeta o no tienes permiso para eliminarla.' });
            }

            res.status(200).json({ success: true, message: 'Tarjeta de jugador eliminada.' });

        } catch (error) {
            console.error("Error al eliminar la tarjeta de jugador:", error);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    // CREAMOS UNA CONSTANTE PARA EL CHEQUEO DE ADMIN
    const checkAdmin = [
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        adminOnly(pool)
    ];


    // ==========================================================
    // === PEGA LAS RUTAS DE ADMIN AQUÍ (DENTRO DEL MODULE) ===
    // ==========================================================
    
    // --- RUTA ADMIN: Obtener todos los bots (CON PORTADA INCLUIDA) ---
    router.get('/admin/bots', checkAdmin, async (req, res) => {
        try {
            const query = `
                SELECT 
                    id, username, age, gender, bio, profile_pic_url, 
                    cover_pic_url, gemini_api_key, bot_personality, 
                    bot_allows_images, bot_schedule_type, bot_min_minutes, 
                    bot_max_minutes, bot_specific_hours, 
                    bot_next_post_at  -- <--- ESTA LÍNEA ES VITAL
                FROM usersapp 
                WHERE is_bot = TRUE
            `;
            const result = await pool.query(query);
            
            // LOG DE DEPURACIÓN (Míralo en tu terminal de Node)
            console.log("Dato del servidor:", result.rows[0].bot_next_post_at);
            
            res.json({ success: true, bots: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, message: 'Error al obtener bots' });
        }
    });

    // --- RUTA ADMIN: Actualizar configuración completa de un Bot ---
    router.post('/admin/update-bot', checkAdmin,
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadMiddleware,
        processImage('profile'),
        async (req, res) => {
            const { 
                id, username, age, gender, bio, bot_personality, 
                bot_allows_images, gemini_api_key, profile_pic_url, 
                cover_pic_url, bot_schedule_type, bot_min_minutes, 
                bot_max_minutes, bot_specific_hours 
            } = req.body;

            // --- ¡NUEVA LÓGICA DE RECALCULO! ---
            const { calculateNextPostTime } = require('../modules/botManager');
            
            // Creamos un objeto temporal con los nuevos datos para calcular la fecha
            const nextPostAt = calculateNextPostTime({
                bot_schedule_type,
                bot_min_minutes,
                bot_max_minutes,
                bot_specific_hours
            });

            let finalProfilePic = profile_pic_url;
            if (req.file) {
                finalProfilePic = `/uploads/profile_images/${req.file.filename}`;
            }

            try {
                const query = `
                    UPDATE usersapp SET 
                        username = $1, bio = $2, bot_personality = $3, age = $4, 
                        gender = $5, bot_allows_images = $6, gemini_api_key = $7, 
                        profile_pic_url = $8, cover_pic_url = $9,
                        bot_schedule_type = $10, bot_min_minutes = $11, 
                        bot_max_minutes = $12, bot_specific_hours = $13,
                        bot_next_post_at = $14 -- <--- ACTUALIZAMOS LA FECHA AQUÍ
                    WHERE id = $15 AND is_bot = TRUE
                `;

                const values = [
                    username, bio, bot_personality, parseInt(age), gender,
                    bot_allows_images === 'true', gemini_api_key, finalProfilePic, cover_pic_url,
                    bot_schedule_type, parseInt(bot_min_minutes), parseInt(bot_max_minutes), bot_specific_hours,
                    nextPostAt, // El nuevo valor calculado ($14)
                    id          // $15
                ];

                await pool.query(query, values);
                
                res.json({ 
                    success: true, 
                    message: 'Configuración y horario actualizados',
                    newNextPostAt: nextPostAt // Lo devolvemos para el Front
                });
            } catch (error) {
                console.error("❌ Error SQL en /admin/update-bot:", error);
                res.status(500).json({ 
                    success: false, 
                    message: 'Error interno del servidor al guardar en la base de datos.' 
                });
            }
        }
    );


    // --- RUTA ADMIN: Subir foto de perfil de un BOT ---
    router.post('/admin/bots/upload-pic/:id', (req, res, next) => protect(req, res, next, JWT_SECRET), uploadMiddleware, processImage('profile'), async (req, res) => {
        if (!req.file) return res.status(400).json({ success: false, message: 'No se subió imagen.' });
        const profilePicUrl = `/uploads/profile_images/${req.file.filename}`;
        try {
            await pool.query('UPDATE usersapp SET profile_pic_url = $1 WHERE id = $2 AND is_bot = TRUE', [profilePicUrl, req.params.id]);
            res.json({ success: true, profilePicUrl });
        } catch (error) { res.status(500).json({ success: false }); }
    });

    // --- RUTA ADMIN: Subir portada de un BOT ---
    router.post('/admin/bots/upload-cover/:id', (req, res, next) => protect(req, res, next, JWT_SECRET), uploadCoverMiddleware, processImage('cover'), async (req, res) => {
        if (!req.file) return res.status(400).json({ success: false, message: 'No se subió imagen.' });
        const coverPicUrl = `/uploads/cover_images/${req.file.filename}`;
        try {
            await pool.query('UPDATE usersapp SET cover_pic_url = $1 WHERE id = $2 AND is_bot = TRUE', [coverPicUrl, req.params.id]);
            res.json({ success: true, coverPicUrl });
        } catch (error) { res.status(500).json({ success: false }); }
    });


    // --- RUTA ADMIN: Forzar publicación de un bot ---
    router.post('/admin/bots/trigger-post/:id', checkAdmin, (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        // Importamos la función desde el módulo (Node permite require dentro de funciones)
        const { executeSinglePost } = require('../modules/botManager');
        
        const result = await executeSinglePost(pool, req.app.get('socketio'), req.params.id);
        
        if (result.success) {
            res.json({ success: true, message: '¡Publicación enviada!', caption: result.caption });
        } else {
            res.status(500).json({ success: false, message: result.error });
        }
    });


    // --- RUTA ADMIN: Crear un nuevo Bot ---
    router.post('/admin/bots/create', checkAdmin, (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { username } = req.body;
        
        // Generamos un email único para el bot para evitar conflictos de Base de Datos
        const botEmail = `bot_${Date.now()}_${Math.floor(Math.random() * 1000)}@system.com`;

        try {
            const query = `
                INSERT INTO usersapp (
                    email, username, is_bot, bio, 
                    bot_schedule_type, bot_min_minutes, bot_max_minutes,
                    profile_pic_url
                ) 
                VALUES ($1, $2, TRUE, 'Nuevo Bot IA', 'interval', 30, 60, '/assets/img/default-avatar.png') 
                RETURNING id;
            `;

            const result = await pool.query(query, [botEmail, username || 'Nuevo Bot']);
            
            res.json({ 
                success: true, 
                message: 'Bot creado con éxito', 
                botId: result.rows[0].id 
            });
        } catch (error) {
            console.error("Error al crear bot:", error);
            res.status(500).json({ success: false, message: 'No se pudo crear el bot' });
        }
    });


    // --- RUTA ADMIN: Eliminar un Bot permanentemente ---
    router.delete('/admin/bots/delete/:id', checkAdmin, (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { id } = req.params;

        try {
            // Intentamos borrar al bot
            const result = await pool.query('DELETE FROM usersapp WHERE id = $1 AND is_bot = TRUE', [id]);

            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, message: 'Bot no encontrado o no es un bot.' });
            }

            console.log(`🗑️ Bot con ID ${id} eliminado por el administrador.`);
            res.json({ success: true, message: 'Bot y todo su contenido eliminados con éxito.' });

        } catch (error) {
            console.error("Error al eliminar bot:", error);
            res.status(500).json({ success: false, message: 'Error interno al intentar eliminar el bot.' });
        }
    });




    // --- RUTA ADMIN: Eliminar una publicación de un bot (sin ser el dueño) ---
    router.delete('/admin/posts/:postId', checkAdmin, async (req, res) => {
        const { postId } = req.params;

        try {
            // Ejecutamos el borrado directamente. 
            // Gracias al checkAdmin, sabemos que quien pide esto tiene permiso.
            const result = await pool.query('DELETE FROM postapp WHERE post_id = $1', [postId]);

            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, message: 'La publicación no existe.' });
            }

            console.log(`🗑️ Post ID ${postId} eliminado por administrador.`);
            res.json({ success: true, message: 'Publicación eliminada correctamente.' });
        } catch (error) {
            console.error("❌ Error SQL al eliminar post de bot:", error);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });



    // --- RUTA ADMIN: Notificar a todos sobre una nueva actualización ---
    router.post('/admin/announce-update', checkAdmin, async (req, res) => {
        const { versionName, notes } = req.body;

        try {
            // 1. Obtenemos todos los usuarios que tienen un token de notificación
            const result = await pool.query('SELECT fcm_token FROM usersapp WHERE fcm_token IS NOT NULL');
            const tokens = result.rows.map(r => r.fcm_token);

            if (tokens.length === 0) {
                return res.json({ success: true, message: 'No hay usuarios para notificar.' });
            }

            // 2. Preparamos el mensaje de "SOLO DATOS" para que el Java lo maneje
            // Usamos un loop o enviamos en batch (máximo 500 por envío en FCM)
            const message = {
                notification: { // Esta vez incluimos 'notification' para que Android lo muestre aunque la app esté cerrada
                    title: '🚀 ¡Nueva Actualización!',
                    body: `La versión ${versionName} ya está disponible. ¡Entra para ver las novedades!`,
                },
                data: {
                    type: 'update_alert',
                    version: versionName,
                    openUrl: 'home.html' // Al tocarla, abrirá el Home donde salta el modal de actualizar
                },
                // Enviamos a todos los tokens encontrados
            };

            // Enviamos las notificaciones una por una (para simplificar el código)
            const sendPromises = tokens.map(token => {
                return admin.messaging().send({ ...message, token }).catch(e => console.error("Token inválido:", token));
            });

            await Promise.all(sendPromises);

            res.json({ success: true, message: `Notificación enviada a ${tokens.length} usuarios.` });

        } catch (error) {
            console.error("Error al enviar anuncio:", error);
            res.status(500).json({ success: false, message: 'Fallo al enviar notificaciones.' });
        }
    });

    return router;
};