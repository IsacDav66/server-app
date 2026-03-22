const multer = require('multer');

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    // Aceptamos imágenes y gifs
    if (file.mimetype.startsWith('image/') || file.mimetype === 'image/gif') {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten archivos de imagen o GIF.'), false);
    }
};

const uploadBadge = multer({ 
    storage: storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB es suficiente para una insignia
    fileFilter: fileFilter
});

module.exports = uploadBadge.single('badgeFile');