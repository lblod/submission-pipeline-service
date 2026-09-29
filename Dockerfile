FROM semtech/mu-javascript-template:1.9.1

# see https://github.com/mu-semtech/mu-javascript-template for more info

# Downloaded files and harvested Turtle are stored here; mount the stack's file volume.
RUN mkdir -p /share
