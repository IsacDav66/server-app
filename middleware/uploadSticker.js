// /server/middleware/uploadSticker.js
const multer = require('multer');
const path = require('path');

// Configuración de almacenamiento para guardar en una carpeta temporal
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Guardamos en una carpeta 'stickers_temp' dentro de 'uploads'
        cb(null, path.join(__dirname, '../uploads/stickers_temp/'));
    },
    filename: function (req, file, cb) {
        // Generamos un nombre de archivo único para evitar colisiones
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    // Aceptamos imágenes, GIFs y videos
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
        cb(null, true);
    } else {
        cb(new Error('Tipo de archivo no soportado.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 15 * 1024 * 1024 }, // Límite de 15MB para videos/gifs
    fileFilter: fileFilter
});

module.exports = upload.single('stickerFile');