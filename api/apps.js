// /server/api/apps.js
const express = require('express');
const { protect } = require('../middleware/auth');
const uploadImageMiddleware = require('../middleware/uploadImage');
const processImage = require('../middleware/processImage');

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

    // RUTA PARA AÑADIR UNA NUEVA APP
    router.post('/add', 
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadImageMiddleware,
        processImage('app_icon'),
        async (req, res) => {
            const { packageName, appName } = req.body;
            const userId = req.user.userId;
            let iconUrl = req.file ? `/uploads/app_icon/${req.file.filename}` : null;
            if (!packageName || !appName) {
                return res.status(400).json({ success: false, message: 'Faltan datos.' });
            }
            try {
                const query = `
                    INSERT INTO detected_apps (package_name, app_name, icon_url, added_by_user_id)
                    VALUES ($1, $2, $3, $4) RETURNING *;
                `;
                const result = await pool.query(query, [packageName, appName, iconUrl, userId]);
                res.status(201).json({ success: true, app: result.rows[0] });
            } catch (error) {
                res.status(error.code === '23505' ? 409 : 500).json({ success: false, message: 'La app ya existe o hubo un error.' });
            }
        }
    );

    return router;
};