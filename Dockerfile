FROM semtech/mu-javascript-template:1.9.1

# see https://github.com/mu-semtech/mu-javascript-template for more info

# All queries run as sudo; see lib/sparql-helpers.js.
ENV ALLOW_MU_AUTH_SUDO=true

# The template logs every query and its auth headers by default. Failed queries are
# still logged by lib/sparql-helpers.js.
ENV LOG_SPARQL_ALL=false
ENV DEBUG_AUTH_HEADERS=false

# Downloaded files and harvested Turtle are stored here; mount the stack's file volume.
RUN mkdir -p /share
