FROM node:22 AS yarn
COPY . ./
FROM php:8.3-apache
COPY . ./
CMD ["apache2-foreground"]
