FROM nginx:alpine
COPY landing/ /usr/share/nginx/html/
EXPOSE 80
