// Archivo: /server/api/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    // --- FUNCIÓN AUXILIAR PARA ASIGNAR INSIGNIAS AUTOMÁTICAS ---
    // La creamos aquí para no repetir código en Register y Google
    const assignAutoBadges = async (userId) => {
        try {
            const activeRules = await pool.query(`
                SELECT badge_id FROM badge_rules 
                WHERE type = 'global_indefinite' 
                OR (type = 'global_limited' AND end_date > CURRENT_TIMESTAMP)
            `);
            
            for (let rule of activeRules.rows) {
                await pool.query(
                    'INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [userId, rule.badge_id]
                );
            }
            if (activeRules.rows.length > 0) {
                console.log(`🏅 Se asignaron ${activeRules.rows.length} insignias automáticas al usuario ${userId}`);
            }
        } catch (err) {
            console.error("❌ Error en asignación automática de insignias:", err);
        }
    };

    // ----------------------------------------------------
    // RUTA DE REGISTRO (/api/auth/register)
    // ----------------------------------------------------
    router.post('/register', async (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ success: false, message: 'Falta correo o contraseña.' });

        try {
            const salt = await bcrypt.genSalt(10);
            const passwordHash = await bcrypt.hash(password, salt);

            const query = 'INSERT INTO usersapp (email, password_hash) VALUES ($1, $2) RETURNING id';
            const result = await pool.query(query, [email, passwordHash]);
            const userId = result.rows[0].id;

            // ==========================================================
            // 🏅 LÓGICA DE INSIGNIAS AUTOMÁTICAS (NUEVO)
            // ==========================================================
            await assignAutoBadges(userId);
            // ==========================================================
            
            const token = jwt.sign({ userId: userId }, JWT_SECRET, { expiresIn: '30d' });

            res.status(201).json({ 
                success: true, 
                message: 'Usuario registrado con éxito e iniciado sesión.',
                userId: userId,
                token: token 
            });
        } catch (error) {
            if (error.code === '23505') return res.status(409).json({ success: false, message: 'Ese correo ya está registrado.' });
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    // ----------------------------------------------------
    // RUTA DE LOGIN (/api/auth/login)
    // ----------------------------------------------------
    router.post('/login', async (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ success: false, message: 'Falta correo o contraseña.' });

        try {
            const query = 'SELECT id, password_hash FROM usersapp WHERE email = $1';
            const result = await pool.query(query, [email]);
            if (result.rows.length === 0) return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });

            const user = result.rows[0];
            const isValidPassword = await bcrypt.compare(password, user.password_hash);
            if (!isValidPassword) return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });

            const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
            
            res.status(200).json({ 
                success: true, 
                message: 'Inicio de sesión exitoso.', 
                userId: user.id,
                token: token
            });
        } catch (error) {
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    // ====================================================
    // === NUEVA RUTA: INICIO DE SESIÓN CON GOOGLE      ===
    // ====================================================
    router.post('/google', async (req, res) => {
        const { token } = req.body;
        try {
            const ticket = await client.verifyIdToken({
                idToken: token,
                audience: process.env.GOOGLE_CLIENT_ID,
            });
            const { email, name, picture } = ticket.getPayload();

            let userResult = await pool.query('SELECT * FROM usersapp WHERE email = $1', [email]);
            let user;

            if (userResult.rows.length > 0) {
                user = userResult.rows[0];
            } else {
                // EL USUARIO ES NUEVO -> REGISTRO
                const newUserQuery = `
                    INSERT INTO usersapp (email, username, profile_pic_url)
                    VALUES ($1, $2, $3)
                    RETURNING *;
                `;
                const newUsername = name.replace(/ /g, '').substring(0, 15) + Math.floor(Math.random() * 1000);
                const newUserResult = await pool.query(newUserQuery, [email, newUsername, picture]);
                user = newUserResult.rows[0];

                // ==========================================================
                // 🏅 LÓGICA DE INSIGNIAS AUTOMÁTICAS (NUEVO - PARA GOOGLE)
                // ==========================================================
                await assignAutoBadges(user.id);
                // ==========================================================
            }
            
            const appToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

            res.status(200).json({
                success: true,
                message: 'Inicio de sesión con Google exitoso.',
                token: appToken
            });

        } catch (error) {
            console.error("Error en la verificación de Google:", error);
            res.status(401).json({ success: false, message: 'Token de Google inválido o expirado.' });
        }
    });

    return router;
};