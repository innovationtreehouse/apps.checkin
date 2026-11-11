// The kiosk flow tier: the flow config, on its own files and with room for real
// restarts. Run by deploy/kiosk-flow.sh, which provides the kiosk images.
import flowConfig from './jest.flow.config.js';

const kioskFlowConfig = async () => ({
    ...(await flowConfig()),
    testMatch: ['<rootDir>/kiosk-flow/**/*.kiosk-flow.ts'],
    testTimeout: 300000,
});

export default kioskFlowConfig;
