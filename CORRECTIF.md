# Correctif des interlignes — HTML to Figma

Installation sous Windows :
1. Extraire entièrement cette archive dans un dossier permanent.
2. Ouvrir chrome://extensions et activer le mode développeur.
3. Désactiver l'ancienne extension pour éviter de lancer la mauvaise version.
4. Cliquer sur « Charger l'extension non empaquetée », sélectionner le dossier dist.
5. Recharger la page web à capturer puis lancer une nouvelle capture et coller dans Figma.

Correction : le calcul de l'interligne normal utilise deux lignes réelles du navigateur,
au lieu de mesurer les limites des glyphes d'un span positionné. Les styles sont lus
avant toute modification pour respecter les titres avec des spans plus petits.
La racine sélectionnée est incluse. Le calcul intervient après l'attente des polices,
à chaque viewport, et les styles d'origine sont restaurés même si la conversion échoue.
Les interlignes explicites restent inchangés.

Sources et diff inclus. Dépôt d'origine :
https://github.com/JackAdamsJenkins/HTML-to-FIGMA

Pour reconstruire : npm ci puis npm run build.
Tests navigateur : npx playwright install chromium puis npm test.

Limites : ce correctif cible des défauts constatés dans le code. Il ne garantit pas
la correction de tout chevauchement : une police absente dans Figma, un retour à
la ligne différent dans le moteur de conversion ou une hauteur CSS fixe peuvent
également créer des écarts. La validation du collage final dans Figma reste à faire
sur la page qui présente le problème.

Validation effectuée : npm run build et git diff --check réussis.
Tests Playwright fournis mais non exécutés : navigateur indisponible, téléchargement bloqué/invalide dans cet environnement.
