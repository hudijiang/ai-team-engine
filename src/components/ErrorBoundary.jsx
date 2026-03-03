import React from 'react';

/**
 * 全局错误边界组件
 * 捕获子组件渲染异常，防止白屏
 */
export default class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, errorInfo) {
        console.error('[ErrorBoundary] 渲染异常:', error, errorInfo);
    }

    handleReset = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: '100vh',
                    background: '#0A0E17',
                    color: '#F1F5F9',
                    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
                    gap: '16px',
                    padding: '32px',
                }}>
                    <div style={{ fontSize: '48px' }}>⚠️</div>
                    <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>系统渲染异常</h1>
                    <p style={{ color: '#94A3B8', fontSize: '0.9rem', maxWidth: '480px', textAlign: 'center' }}>
                        {this.state.error?.message || '发生了未知错误'}
                    </p>
                    <button
                        onClick={this.handleReset}
                        style={{
                            padding: '10px 24px',
                            background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '10px',
                            cursor: 'pointer',
                            fontSize: '0.9rem',
                            fontWeight: 600,
                        }}
                    >
                        重新加载
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
