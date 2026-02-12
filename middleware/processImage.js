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

    const userId = req.user.adminTargetId || req.user.userId;
    const timestamp = Date.now();
    
    // Mantenemos la extensión .webp porque el formato WebP animado 
    // es mucho más ligero y eficiente que el GIF original.
    const newFilename = `${type}_${userId}_${timestamp}.webp`;
    const fullFilePath = path.join(destinationPath, newFilename);

    try {
        // --- CAMBIO 1: AÑADIR { animated: true } ---
        // Esto le dice a Sharp que si es un GIF, lea todos sus fotogramas.
        const pipeline = sharp(req.file.buffer, { animated: true });

        // Obtenemos metadatos para saber si es muy grande o si es animado
        const metadata = await pipeline.metadata();

        await pipeline
            // Redimensionamos (mantiene la animación si animated: true)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            // --- CAMBIO 2: CONFIGURACIÓN DE WEBP ---
            // Sharp detectará automáticamente si el origen es animado y creará un WebP animado.
            .webp({ 
                quality: 80,
                // Si quieres que los GIFs pesen menos, puedes activar la reducción de frames aquí
                // pero por ahora con animated:true es suficiente.
            })
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