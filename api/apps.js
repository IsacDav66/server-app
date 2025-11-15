// /server/api/apps.js
const express = require('express');
const { protect } = require('../middleware/auth');


module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // RUTA PARA OBTENER INFO DE UNA APP (MODIFICADA)
    router.get('/:packageName', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { packageName } = req.params;
        try {
            // Se añade 'is_game' a la consulta
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
            // ... (código existente sin cambios)
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

    return router;
};