// Carga las variables de entorno del archivo .env
require('dotenv').config({ path: './.env' }); 

// --- IMPORTACIONES ---
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const admin = require('firebase-admin');
const { startAutonomousBot } = require('./modules/botManager'); // <--- 1. ASEGURAR ESTO

// --- CONFIGURACIÓN PRINCIPAL ---
const app = express();
const PORT = 3001;
const INTERNAL_HOST = '0.0.0.0'; 
const JWT_SECRET = 'TuSuperClaveSecretaJWT9876543210'; // ¡Usa process.env.JWT_SECRET en producción!

const server = http.createServer(app);

const adminRoutes = require('./api/admin'); 
const pendingMatchLikes = {};
let matchQueue = [];
const matchReconnectTimers = {};
// --- CONFIGURACIÓN DE SOCKET.IO ---
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    path: "/app/socket.io/"
});
app.set('socketio', io);

// --- INICIALIZACIÓN DE FIREBASE ADMIN ---
try {
    const serviceAccount = require('./config/firebase-service-account.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin SDK inicializado correctamente.');
} catch (error) {
    console.error('❌ Error al inicializar Firebase Admin SDK:', error.message);
}

// --- CONFIGURACIÓN DE BASE DE DATOS ---
if (!process.env.DATABASE_URL) {
    console.error('❌ Error: DATABASE_URL no está definido en el archivo .env');
    process.exit(1);
}
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
pool.connect()
    .then(client => {
        console.log('✅ Conexión exitosa a PostgreSQL.');
        client.release();
    })
    .catch(err => {
        console.error('❌ Error de conexión a PostgreSQL:', err.stack);
        process.exit(1);
    });

// --- CONFIGURACIÓN DE MIDDLEWARE ---

// ==========================================================
// === ¡AÑADE ESTE BLOQUE PARA HABILITAR SharedArrayBuffer! ===
// ==========================================================
// Este middleware añade las cabeceras necesarias para el aislamiento de origen cruzado.
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
});
// ==========================================================

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads/emojis', express.static(path.join(__dirname, 'uploads/emojis')));
app.use('/updates', express.static(path.join(__dirname, 'public', 'updates')));
app.use('/api/admin', adminRoutes(pool, JWT_SECRET));

// --- MAPA DE USUARIOS EN LÍNEA ---
const onlineUsers = new Map();
app.set('onlineUsers', onlineUsers);



// --- LÓGICA DE WEBSOCKETS ---
io.on('connection', (socket) => {
    // 🚀 FUNCIÓN DE CIERRE DE MATCH (Ponla al principio del io.on)
    const handleMatchLeave = (userId) => {
        // Si ya hay un temporizador corriendo para este usuario, lo limpiamos
        if (matchReconnectTimers[userId]) clearTimeout(matchReconnectTimers[userId]);

        // 🚀 Esperamos 10 segundos antes de destruir el match
        matchReconnectTimers[userId] = setTimeout(async () => {
            for (const roomId in pendingMatchLikes) {
                if (roomId.startsWith('match_') && roomId.includes(`_${userId}`)) {
                    const parts = roomId.replace('match_', '').split('_');
                    const partnerId = parts.find(id => id !== String(userId));

                    console.log(`🛸 Abandono confirmado: El usuario ${userId} no regresó. Avisando a ${partnerId}`);

                    io.to(roomId).emit('match_terminated', { reason: 'partner_left' });
                    io.to(`user-${partnerId}`).emit('match_terminated', { reason: 'partner_left' });

                    try {
                        await pool.query('DELETE FROM messagesapp WHERE room_name = $1', [roomId]);
                    } catch (err) { console.error("Error al borrar:", err); }

                    delete pendingMatchLikes[roomId];
                }
            }
            delete matchReconnectTimers[userId];
        }, 10000); // 10 segundos es tiempo suficiente para cargar el chat
    };




    console.log('🔌 Un usuario se ha conectado:', socket.id);

    const notifyFriendsOfStatusChange = async (userId, isOnline, currentAppInfo = null) => {
        try {
            const query = `
                SELECT f1.follower_id as friend_id
                FROM followersapp f1
                INNER JOIN followersapp f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id
                WHERE f1.following_id = $1;
            `;
            const result = await pool.query(query, [userId]);
            const friends = result.rows;
            if (friends.length === 0) return;

            const payload = { 
                userId: userId, 
                isOnline: isOnline,
                currentApp: currentAppInfo ? currentAppInfo.name : null,
                currentAppIcon: currentAppInfo ? currentAppInfo.icon : null,
                currentAppPackage: currentAppInfo ? currentAppInfo.package : null
            };

            friends.forEach(friend => {
                const friendRoom = `user-${friend.friend_id}`;
                io.to(friendRoom).emit('friend_status_update', payload);
            });
        } catch (error) {
            console.error("❌ Error en notifyFriendsOfStatusChange:", error);
        }
    };

    socket.on('authenticate', (token) => {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.userId) {
                const userId = decoded.userId;
                socket.userId = userId;
                const userRoom = `user-${userId}`;
                socket.join(userRoom);
                onlineUsers.set(socket.id, { userId: userId, currentApp: null });
                console.log(`✅ Socket ${socket.id} autenticado como user ${userId} y unido a la sala ${userRoom}`);
                notifyFriendsOfStatusChange(userId, true, null);
            }
        } catch (error) {
            console.log(`❌ Fallo de autenticación para socket ${socket.id}`);
        }
    });

    socket.on('update_current_app', async (appData) => {
        if (!socket.userId) return;
        let finalAppData = null;
        if (appData && appData.package) {
            try {
                const result = await pool.query('SELECT * FROM detected_apps WHERE package_name = $1', [appData.package]);
                if (result.rows.length > 0) {
                    const dbApp = result.rows[0];
                    finalAppData = { name: dbApp.app_name, package: dbApp.package_name, icon: dbApp.icon_url, is_game: dbApp.is_game };
                    
                    // Registrar en historial de apps
                    const upsertHistoryQuery = `INSERT INTO user_app_history (user_id, package_name, last_seen_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (user_id, package_name) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP;`;
                    await pool.query(upsertHistoryQuery, [socket.userId, dbApp.package_name]);

                    // Si es un juego, registrar en historial de juegos
                    if (dbApp.is_game === true) {
                        const upsertGameQuery = `INSERT INTO user_played_games (user_id, package_name, last_played_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (user_id, package_name) DO UPDATE SET last_played_at = CURRENT_TIMESTAMP;`;
                        await pool.query(upsertGameQuery, [socket.userId, dbApp.package_name]);
                    }
                } else {
                    finalAppData = { name: appData.name, package: appData.package, icon: null, unregistered: true };
                }
            } catch (dbError) {
                console.error("❌ Error al buscar/registrar app en la BD:", dbError);
                finalAppData = { name: appData.name, package: appData.package, icon: null };
            }
        }
        
        const userData = onlineUsers.get(socket.id);
        if (userData && (userData.currentApp?.package !== finalAppData?.package)) {
            userData.currentApp = finalAppData;
            onlineUsers.set(socket.id, userData);
            notifyFriendsOfStatusChange(socket.userId, true, finalAppData);
        }
    });

    socket.on('join_room', (roomName) => {
        socket.join(roomName);
        
        // 🚀 SI EL USUARIO ENTRA A LA SALA DE MATCH, CANCELAMOS SU BORRADO
        if (roomName.startsWith('match_') && socket.userId) {
            if (matchReconnectTimers[socket.userId]) {
                console.log(`✨ Usuario ${socket.userId} volvió a tiempo. Cancelando autodestrucción.`);
                clearTimeout(matchReconnectTimers[socket.userId]);
                delete matchReconnectTimers[socket.userId];
            }
        }
    });

    socket.on('send_message', async (data) => {
     // 1. Extraemos los datos del cliente, incluyendo el pack de stickers
    const { sender_id, receiver_id, content, roomName, parent_message_id, message_id: tempId, sticker_pack, emoji_pack } = data;

    // LOG DE ENTRADA
    console.log(`📨 [SERVER] Recibido mensaje de ${sender_id} para ${receiver_id}. Pack: ${sticker_pack ? sticker_pack.name : 'Ninguno'}`);

    try {
        // 1. Guardar el nuevo mensaje en la base de datos
        // Nota: No guardamos el sticker_pack en la BD porque la tabla no tiene esa columna,
        // pero lo pasaremos "en vivo" a través del socket.
         const insertQuery = `
            INSERT INTO messagesapp (sender_id, receiver_id, content, room_name, parent_message_id, sticker_pack, emoji_pack) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`;
            
        const insertResult = await pool.query(insertQuery, [
            sender_id, receiver_id, content, roomName, parent_message_id || null, 
            sticker_pack ? JSON.stringify(sticker_pack) : null,
            emoji_pack ? JSON.stringify(emoji_pack) : null // 👈 Nuevo
        ]);
        
        let savedMessage = insertResult.rows[0]; // Objeto que contiene el message_id real generado por la BD

        // =========================================================
        // === ¡LA CLAVE!: RE-INYECTAR EL PACK AL OBJETO A ENVIAR ===
        // =========================================================
        if (sticker_pack) {
            savedMessage.sticker_pack = sticker_pack;
            console.log(`📦 [SERVER] Re-inyectando pack "${sticker_pack.name}" al mensaje para el destinatario.`);
        }
        if (emoji_pack) {
            savedMessage.emoji_pack = emoji_pack; // 👈 Nuevo
            console.log(`📦 [SERVER] Re-inyectando pack "${emoji_pack.name}" al mensaje para el destinatario.`);
        }
        // =========================================================

        // =========================================================
        // === LÓGICA DE ENRIQUECIMIENTO (RESPUESTAS) ===
        // =========================================================
        if (savedMessage.parent_message_id) {
            const parentQuery = `
                SELECT 
                    p.content as parent_content,
                    pu.username as parent_username
                FROM messagesapp AS p
                JOIN usersapp AS pu ON p.sender_id = pu.id
                WHERE p.message_id = $1;
            `;
            const parentResult = await pool.query(parentQuery, [savedMessage.parent_message_id]);
            
            if (parentResult.rows.length > 0) {
                savedMessage.parent_content = parentResult.rows[0].parent_content;
                savedMessage.parent_username = parentResult.rows[0].parent_username;
            }
        }
        // =========================================================

        // 3. Emitimos el mensaje (ahora enriquecido) al otro usuario en la sala
        socket.to(roomName).emit('receive_message', savedMessage);
        console.log(`📩 [SERVER] Mensaje emitido a sala: ${roomName}. ¿Lleva pack?: ${!!savedMessage.sticker_pack}`);

        // 4. Enviamos la confirmación al emisor original para quitar el reloj de carga
        socket.emit('message_confirmed', {
            tempId: tempId,
            realMessage: savedMessage
        });

        console.log(`📝 [DB-SAVE] Intentando guardar mensaje:`);
        console.log(`   - De: ${sender_id} Para: ${receiver_id}`);
        console.log(`   - En columna room_name: "${roomName}"`);
        // ==========================================================
        // === LÓGICA DE NOTIFICACIÓN PUSH PARA MENSAJES ===
        // ==========================================================

        try {
            const recipientResult = await pool.query('SELECT fcm_token FROM usersapp WHERE id = $1', [receiver_id]);
            const senderResult = await pool.query('SELECT username, profile_pic_url FROM usersapp WHERE id = $1', [sender_id]);

            const recipient = recipientResult.rows[0];
            const sender = senderResult.rows[0];

            if (recipient && recipient.fcm_token) {
                const message = {
                    token: recipient.fcm_token,
                    data: {
                        title: sender.username,
                        body: content,
                        channelId: 'chat_messages_channel',
                        groupId: String(sender_id),
                        senderId: String(sender_id),
                        openUrl: `chat.html?userId=${sender_id}`,
                        imageUrl: sender.profile_pic_url ? (process.env.PUBLIC_SERVER_URL + sender.profile_pic_url).trim() : ""
                    },
                    android: { priority: 'high' }
                };

                try {
                    await admin.messaging().send(message);
                    console.log(`✅ [PUSH] Enviado correctamente a usuario ${receiver_id}`);
                } catch (pushError) {
                    if (pushError.code === 'messaging/registration-token-not-registered' || 
                        pushError.code === 'messaging/invalid-registration-token') {
                        console.warn(`🗑️ [PUSH] Token inválido detectado para el usuario ${receiver_id}. Borrando de la DB...`);
                        await pool.query('UPDATE usersapp SET fcm_token = NULL WHERE id = $1', [receiver_id]);
                    } else {
                        console.error("❌ [PUSH] Error desconocido de Firebase:", pushError.message);
                    }
                }
            }
        } catch (error) {
            console.error("❌ [SERVER] Error general en proceso de Push:", error);
        }

    } catch (error) {
        console.error("❌ [SERVER] Error al guardar o enviar el mensaje:", error);
    }
    }); // 🚀 AQUÍ SE CIERRA CORRECTAMENTE EL EVENTO SEND_MESSAGE

    // --- 2. EVENTOS DE MATCHMAKING (SALA DE ENCUENTROS) ---
    socket.on('start_match_search', async () => {
        const userId = socket.userId;
        if (!userId) return;

        // 1. Limpiar si ya estaba en la cola para evitar duplicados
        matchQueue = matchQueue.filter(u => u.userId !== userId);

        console.log(`🔍 Usuario ${userId} buscando pareja. Usuarios en espera: ${matchQueue.length}`);

        // 2. Intentar encontrar una pareja válida en la cola
        let partnerIndex = -1;

        for (let i = 0; i < matchQueue.length; i++) {
            const potentialPartner = matchQueue[i];

            // 🚀 VERIFICACIÓN DE SEGURIDAD: ¿Ya hablaron antes?
            const historyCheck = await pool.query(`
                SELECT 1 FROM messagesapp 
                WHERE (sender_id = $1 AND receiver_id = $2) 
                OR (sender_id = $2 AND receiver_id = $1)
                LIMIT 1
            `, [userId, potentialPartner.userId]);

            if (historyCheck.rowCount === 0) {
                // ¡No hay historial! Es una pareja válida
                partnerIndex = i;
                break; 
            } else {
                console.log(`Keep searching: ${userId} y ${potentialPartner.userId} ya tienen un chat previo.`);
            }
        }

        // 3. Lógica de Match o Espera
        if (partnerIndex !== -1) {
            // Extraemos a la pareja elegida de la cola
            const partner = matchQueue.splice(partnerIndex, 1)[0];
            const roomId = `match_${Math.min(userId, partner.userId)}_${Math.max(userId, partner.userId)}`;

            // Registrar en memoria temporal
            pendingMatchLikes[roomId] = {
                likes: [],
                expiresAt: Date.now() + (7 * 60 * 1000) // 1 min para pruebas
            };

            socket.join(roomId);
            const partnerSocket = io.sockets.sockets.get(partner.socketId);
            if (partnerSocket) partnerSocket.join(roomId);

            // Notificar a ambos
            io.to(socket.id).emit('match_found', { 
                roomId, 
                partnerId: partner.userId, 
                expiresAt: pendingMatchLikes[roomId].expiresAt 
            });
            io.to(partner.socketId).emit('match_found', { 
                roomId, 
                partnerId: userId, 
                expiresAt: pendingMatchLikes[roomId].expiresAt 
            });

            console.log(`🛸 MATCH SEGURO CREADO: ${roomId}`);
        } else {
            // No hay nadie disponible que no conozca, lo ponemos en la cola
            matchQueue.push({ userId, socketId: socket.id });
        }
    });

    socket.on('cancel_match_search', () => {
        matchQueue = matchQueue.filter(u => u.socketId !== socket.id);
    });

    socket.on('press_match_like', async (data) => {
        const { roomId } = data;
        const userId = socket.userId;
        if (!pendingMatchLikes[roomId]) return;

        if (!pendingMatchLikes[roomId].likes.includes(userId)) {
            pendingMatchLikes[roomId].likes.push(userId);
            
            // 🚀 AVISAR AL OTRO: Emitimos un evento al compañero
            socket.to(roomId).emit('partner_liked'); 
        }

        if (pendingMatchLikes[roomId].likes.length === 2) {
            io.to(roomId).emit('match_finalized');
            delete pendingMatchLikes[roomId];
        }
    });

    socket.on('match_time_expired', async (data) => {
        const { roomId } = data;
        
        // 🚩 SEGURIDAD: Solo permitimos borrar si la sala empieza con "match_"
        if (!roomId || !roomId.startsWith('match_')) {
            console.log(`🚫 Intento de borrado bloqueado: Sala no válida (${roomId})`);
            return;
        }

        console.log(`\n--- 🛸 EJECUTANDO AUTODESTRUCCIÓN ---`);
        console.log(`📂 Sala: "${roomId}"`);

        try {
            // 🚀 LA CLAVE: Borramos directamente de la base de datos.
            // El cliente solo envía este evento si el match NO se concretó.
            const res = await pool.query('DELETE FROM messagesapp WHERE room_name = $1', [roomId]);
            
            console.log(`✅ RESULTADO DB: Se eliminaron ${res.rowCount} mensajes.`);

            // Notificamos a los usuarios que el chat murió
            io.to(roomId).emit('match_terminated', { reason: 'timeout' });
            
            // Limpiamos la memoria si es que existía
            if (pendingMatchLikes[roomId]) delete pendingMatchLikes[roomId];

        } catch (error) {
            console.error("❌ ERROR CRÍTICO EN AUTO-DELETE:", error);
        }
        console.log(`---------------------------------------\n`);
    });




    // --- 3. DESCONEXIÓN ---
    socket.on('disconnect', () => {
        console.log(`🔌 Un usuario se ha desconectado: ${socket.id}`);
        matchQueue = matchQueue.filter(u => u.socketId !== socket.id);
        if (socket.userId) {
            handleMatchLeave(socket.userId);
            onlineUsers.delete(socket.id);
            notifyFriendsOfStatusChange(socket.userId, false, null);
        }
         matchQueue = matchQueue.filter(u => u.socketId !== socket.id);
    });
    
    // --- Actualizar el evento leave_match ---
    socket.on('leave_match', () => {
        if (socket.userId) {
            handleMatchLeave(socket.userId);
        }
    });
});

// --- INICIALIZACIÓN DE TABLAS DE LA BASE DE DATOS ---
async function initDatabase() {
    // TABLA DE USUARIOS (usersapp)
    const usersQuery = `
        CREATE TABLE IF NOT EXISTS usersapp (
            id SERIAL PRIMARY KEY,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255),
            created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            username VARCHAR(50) UNIQUE,           
            age INTEGER,
            gender VARCHAR(10),
            profile_pic_url VARCHAR(255)
        );
    `;

    // TABLA DE PUBLICACIONES (postapp)
    const postQuery = `
        CREATE TABLE IF NOT EXISTS postapp (
            post_id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            content TEXT,
            image_url VARCHAR(255),
            video_id VARCHAR(255), -- Columna para el ID de video de YouTube
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // TABLA DE REACCIONES (post_reactionapp)
    const reactionQuery = `
        CREATE TABLE IF NOT EXISTS post_reactionapp (
            reaction_id SERIAL PRIMARY KEY,
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE NOT NULL,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            reaction_type VARCHAR(10) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (post_id, user_id)
        );
    `;

    // TABLA DE POSTS GUARDADOS (saved_postsapp)
    const savedQuery = `
        CREATE TABLE IF NOT EXISTS saved_postsapp (
            saved_post_id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, post_id)
        );
    `;

    // TABLA DE COMENTARIOS (commentsapp)
    const commentsQuery = `
        CREATE TABLE IF NOT EXISTS commentsapp (
            comment_id SERIAL PRIMARY KEY,
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE NOT NULL,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            parent_comment_id INTEGER REFERENCES commentsapp(comment_id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // TABLA DE SEGUIDORES (followersapp)
    const followersQuery = `
        CREATE TABLE IF NOT EXISTS followersapp (
            follower_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            following_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (follower_id, following_id)
        );
    `;

    // --- AÑADE ESTE BLOQUE COMPLETO ---
    const messagesQuery = `
        CREATE TABLE IF NOT EXISTS messagesapp (
            message_id SERIAL PRIMARY KEY,
            sender_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            receiver_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            content TEXT NOT NULL,
            room_name VARCHAR(100), 
            is_read BOOLEAN DEFAULT FALSE,
            parent_message_id INTEGER,
            sticker_pack TEXT,
            emoji_pack TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;
    // --- FIN DEL BLOQUE A AÑADIR ---

    // TABLA DE NOTIFICACIONES (notificationsapp)
    const notificationsQuery = `
        CREATE TABLE IF NOT EXISTS notificationsapp (
            notification_id SERIAL PRIMARY KEY,
            recipient_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL, -- Quién recibe la notificación
            sender_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,    -- Quién la originó
            type VARCHAR(20) NOT NULL, -- 'new_follower', 'like', 'comment'
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE, -- Opcional, para likes/comentarios
            is_read BOOLEAN DEFAULT FALSE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;
    
    // AÑADE ESTA QUERY
     // AÑADE ESTA QUERY
    const detectedAppsQuery = `
        CREATE TABLE IF NOT EXISTS detected_apps (
            package_name VARCHAR(255) PRIMARY KEY,
            app_name VARCHAR(100) NOT NULL,
            icon_url VARCHAR(255),
            added_by_user_id INTEGER REFERENCES usersapp(id),
            is_game BOOLEAN DEFAULT NULL, -- <-- ¡NUEVA COLUMNA!
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;

     // ==========================================================
    // === ¡NUEVA TABLA PARA REGISTRAR JUEGOS JUGADOS! ===
    // ==========================================================
    const userPlayedGamesQuery = `
        CREATE TABLE IF NOT EXISTS user_played_games (
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            package_name VARCHAR(255) REFERENCES detected_apps(package_name) ON DELETE CASCADE NOT NULL,
            last_played_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, package_name)
        );
    `;
    // ==========================================================

    
     // ==========================================================
    // === ¡NUEVA TABLA PARA EL HISTORIAL DE APPS DEL USUARIO! ===
    // ==========================================================
    const userAppHistoryQuery = `
        CREATE TABLE IF NOT EXISTS user_app_history (
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            package_name VARCHAR(255) REFERENCES detected_apps(package_name) ON DELETE CASCADE NOT NULL,
            last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, package_name)
        );
    `;
    // ==========================================================
    // ==========================================================
    // === ¡NUEVA TABLA PARA LAS TARJETAS DE JUGADOR! ===
    // ==========================================================
    const playerCardsQuery = `
        CREATE TABLE IF NOT EXISTS player_cards (
            card_id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            package_name VARCHAR(255) REFERENCES detected_apps(package_name) ON DELETE CASCADE NOT NULL,
            in_game_username VARCHAR(100),
            in_game_id VARCHAR(100),
            invite_link TEXT,
            cover_image_url VARCHAR(255),
            
            -- ¡NUEVA COLUMNA PARA EL ORDEN! --
            display_order INTEGER NOT NULL DEFAULT 0,

            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, package_name)
        );
    `;

    // Dentro de initDatabase(), añade esta query:
    const appVersionsQuery = `
        CREATE TABLE IF NOT EXISTS app_versions (
            id SERIAL PRIMARY KEY,
            version_name VARCHAR(20) NOT NULL,
            version_code INTEGER NOT NULL UNIQUE,
            release_notes TEXT,
            notified BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;
    const mediaLibraryQuery = `
        CREATE TABLE IF NOT EXISTS media_library (
            hash VARCHAR(64) PRIMARY KEY,
            file_path VARCHAR(255) NOT NULL,
            mime_type VARCHAR(50),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
    

    // ==========================================================

    try {
        await pool.query(usersQuery);
        console.log('✅ Tabla "usersapp" verificada/creada.');
        await pool.query(postQuery);
        console.log('✅ Tabla "postapp" verificada/creada.');
        await pool.query(reactionQuery);
        console.log('✅ Tabla "post_reactionapp" verificada/creada.');
        await pool.query(savedQuery);
        console.log('✅ Tabla "saved_postsapp" verificada/creada.');
        await pool.query(commentsQuery);
        console.log('✅ Tabla "commentsapp" verificada/creada.');
        await pool.query(followersQuery);
        console.log('✅ Tabla "followersapp" verificada/creada.');
        // --- AÑADE ESTA LÍNEA ---
        await pool.query(messagesQuery);
        console.log('✅ Tabla "messagesapp" verificada/creada.');
        
        await pool.query(notificationsQuery);
        console.log('✅ Tabla "notificationsapp" verificada/creada.');
        
        // AÑADE ESTA LLAMADA
        await pool.query(detectedAppsQuery);
        console.log('✅ Tabla "detected_apps" verificada/creada.');
    
        // --- AÑADE ESTA LLAMADA ---
        await pool.query(userPlayedGamesQuery);
        console.log('✅ Tabla "user_played_games" verificada/creada.');

        // --- AÑADE ESTA LLAMADA ---
        await pool.query(userAppHistoryQuery);
        console.log('✅ Tabla "user_app_history" verificada/creada.');
        // --- AÑADE ESTA LLAMADA ---
        await pool.query(playerCardsQuery);
        console.log('✅ Tabla "player_cards" verificada/creada.');
        // Y luego ejecútala abajo con las demás:
        await pool.query(appVersionsQuery);
        console.log('✅ Tabla "app_versions" verificada/creada.');
        // tabla media_library
        await pool.query(mediaLibraryQuery);
        console.log('✅ Tabla "media_library" verificada/creada.');
    } catch (err) {
        console.error('❌ Error al inicializar la base de datos:', err.stack);
    }
}
initDatabase();

// --- RUTAS DE LA APLICACIÓN ---
const authRoutes = require('./api/auth');
const userRoutes = require('./api/user'); 
const postRoutes = require('./api/post');
const chatRoutes = require('./api/chat');
const notificationRoutes = require('./api/notifications');
const appApiRoutes = require('./api/apps');

// Montamos cada router en su prefijo correcto
app.use('/api/auth', authRoutes(pool, JWT_SECRET)); 
app.use('/api/user', userRoutes(pool, JWT_SECRET)); 
app.use('/api/posts', postRoutes(pool, JWT_SECRET));
app.use('/api/notifications', notificationRoutes(pool, JWT_SECRET));
app.use('/api/chat', chatRoutes(pool, JWT_SECRET, io));

// ¡LLAMADA SIMPLIFICADA! Ya no pasamos 'fetch'
app.use('/api/apps', appApiRoutes(pool, JWT_SECRET)); 


// Ruta específica para la versión de la app
app.get('/api/app/latest-version', (req, res) => {
    const versionFilePath = path.join(__dirname, 'public', 'updates', 'version.json');
    fs.readFile(versionFilePath, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).json({ success: false, message: "No se pudo obtener la información de la versión." });
        }
        try {
            const versionInfo = JSON.parse(data);
            versionInfo.downloadUrl = `${process.env.PUBLIC_SERVER_URL}/updates/app-release.apk`;
            res.json({ success: true, ...versionInfo });
        } catch (parseErr) {
            res.status(500).json({ success: false, message: "Archivo de versión corrupto." });
        }
    });
});


// Función para notificar actualizaciones pendientes
const checkPendingUpdates = async () => {
    try {
        const res = await pool.query("SELECT * FROM app_versions WHERE notified = FALSE ORDER BY version_code DESC LIMIT 1");
        
        if (res.rows.length > 0) {
            const update = res.rows[0];
            console.log(`📢 Enviando notificaciones para la versión ${update.version_name}...`);

            const tokensRes = await pool.query("SELECT fcm_token FROM usersapp WHERE fcm_token IS NOT NULL");
            const tokens = tokensRes.rows.map(r => r.fcm_token);

            if (tokens.length > 0) {
                // ESTRUCTURA COMPLETA: notification (para el sistema) + data (para tu lógica Java)
                const payload = {
                    notification: {
                        title: '🚀 ¡Nueva Versión Disponible!',
                        body: `Actualiza a la v${update.version_name} para disfrutar de las nuevas mejoras.`
                    },
                    data: {
                        type: 'update_alert',
                        version: update.version_name,
                        openUrl: 'home.html'
                    }
                };

                const sendPromises = tokens.map(token => 
                    admin.messaging().send({ ...payload, token }).catch(() => null)
                );
                await Promise.all(sendPromises);
            }

            // IMPORTANTE: Marcar como notificada para que el setInterval no la vuelva a enviar en 5 min
            await pool.query("UPDATE app_versions SET notified = TRUE WHERE id = $1", [update.id]);
            console.log(`✅ Notificación push enviada para la v${update.version_name}`);
        }
    } catch (e) {
        console.error("Error en vigilante:", e);
    }
};

// Activar el vigilante cada 5 minutos
setInterval(checkPendingUpdates, 1000 * 60 * 5);

// --- MANEJADOR DE ERRORES FINAL ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode).json({
        success: false,
        message: err.message || 'Error interno del servidor.',
    });
});




// --- SERVIDOR DE ESCUCHA ---
const PRODUCTION_API_URL = 'https://davcenter.servequake.com';
server.listen(PORT, INTERNAL_HOST, () => {
    console.log(`📡 Servidor de Node.js escuchando...`);
  
    // 1. Iniciar el bot autónomo
    startAutonomousBot(pool, io); 

    // 2. Ejecutar una comprobación de actualización inmediata al arrancar
    checkPendingUpdates();

    // 3. Dejar el vigilante activo cada 5 minutos
    setInterval(checkPendingUpdates, 1000 * 60 * 5);
});