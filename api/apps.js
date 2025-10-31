// /server/api/apps.js
const express = require('express');
const { protect } = require('../middleware/auth');


module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // RUTA PARA OBTENER INFO DE UNA APP
    router.get('/:packageName', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { packageName } = req.params;
        try {
            const result = await pool.query('SELECT * FROM detected_apps WHERE package_name = $1', [packageName]);
            if (result.rows.length > 0) {
                res.status(200).json({ success: true, found: true, app: result.rows[0] });
            } else {
                res.status(200).json({ success: true, found: false });
            }
        } catch (error) {
            res.status(500).json({ success: false, message: 'Error interno.' });
        }
    });

    // --- RUTA ACTUALIZADA PARA AÑADIR UNA NUEVA APP (SIN ICONO) ---
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

    return router;
};