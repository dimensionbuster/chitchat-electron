// Import from chitchat-web submodule
import { createApp } from 'vue' 
import App from '../chitchat-web/src/App.vue'
import router from '../chitchat-web/src/router'

const vueApp = createApp(App)

vueApp.use(router)

vueApp.mount('#app')
