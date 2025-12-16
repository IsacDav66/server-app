// /server/api/apps.js
const express = require('express');
const { protect } = require('../middleware/auth');


module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // RUTA PARA OBTENER INFO DE UNA APP (VERSIÓN CORREGIDA)
    router.get('/:packageName', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { packageName } = req.params;
        try {
            // --- ¡ASEGÚRATE DE QUE 'is_game' ESTÉ EN ESTA LÍNEA! ---
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

    // RUTA PARA AÑADIR UNA NUEVA APP (sin cambios)
    router.post('/add', 
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        async (req, res) => {
            // Los datos ahora vienen en req.body como JSON
            const { packageName, appName } = req.body;
            const userId = req.user.userId;

            if (!packageName || !appName) {
                return res.status(400).json({ success: false, message: 'Faltan el nombre del paquete o el nombre de la app.' });
            }

            try {
                // No incluimos icon_url en el INSERT por ahora
                const query = `
                    INSERT INTO detected_apps (package_name, app_name, added_by_user_id)
                    VALUES ($1, $2, $3)
                    RETURNING *;
                `;
                const result = await pool.query(query, [packageName, appName, userId]);
                res.status(201).json({ success: true, app: result.rows[0] });
            } catch (error) {
                if (error.code === '23505') {
                    return res.status(409).json({ success: false, message: 'Esta aplicación ya ha sido añadida.' });
                }
                console.error("Error al añadir app:", error);
                res.status(500).json({ success: false, message: 'Error interno del servidor.' });
            }
        }
    );

    // ==========================================================
    // === ¡NUEVA RUTA PARA CLASIFICAR UNA APLICACIÓN! ===
    // ==========================================================
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

    // ======================================================================
    // === ¡NUEVA RUTA PARA OBTENER APPS PENDIENTES DE CATEGORIZACIÓN! ===
    // ======================================================================
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

    return router;
};