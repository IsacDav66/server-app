const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const processImage = (type) => async (req, res, next) => {
    if (!req.file) {
        return next();
    }

    let folder = 'default';
    if (type === 'profile') folder = 'profile_images';
    if (type === 'post') folder = 'post_images';
    if (type === 'cover') folder = 'cover_images'; 
    if (type === 'bio') folder = 'bio_images';
    if (type === 'card_cover') folder = 'card_cover_images';
    
    const destinationPath = path.join(__dirname, `../uploads/${folder}/`);
    fs.mkdirSync(destinationPath, { recursive: true });

    // --- ¡ESTA ES LA MEJORA CLAVE! ---
    // Si la ruta de admin nos envía un 'adminTargetId' (el ID del Bot), lo usamos.
    // De lo contrario, usamos el 'userId' del usuario logueado.
    const userId = req.user.adminTargetId || req.user.userId;
    
    const timestamp = Date.now();
    const newFilename = `${type}_${userId}_${timestamp}.webp`;
    const fullFilePath = path.join(destinationPath, newFilename);

    try {
        await sharp(req.file.buffer)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(fullFilePath);

        req.file.filename = newFilename;
        req.file.path = fullFilePath;
        req.file.destination = destinationPath;

        next();
    } catch (error) {
        console.error('❌ Error al procesar la imagen con Sharp:', error);
        return res.status(500).json({ success: false, message: 'Error al procesar la imagen.' });
    }
};

module.exports = processImage;