// Archivo: /server/middleware/uploadBioImage.js
const multer = require('multer');

const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten archivos de imagen.'), false);
};
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter });

module.exports = upload.single('image'); // Quill envía las imágenes con la clave 'image'```

